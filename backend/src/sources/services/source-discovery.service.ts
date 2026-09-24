import { Inject, Injectable } from '@nestjs/common';
import { and, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import { DRIZZLE } from '../../database/database.constants';
import type { Database } from '../../database/database.types';
import { auditLogs, companies, companyLocations, leadEvidence, sourceRecords } from '../../database/schema/schema';
import { ProviderObservabilityService } from '../../common/observability/provider-observability.service';
import { RequestContextService } from '../../common/observability/request-context.service';
import { UsageService } from '../../usage/usage.service';
import { SearchPlan } from '../../search/types/search-plan.types';
import { SOURCE_PROVIDER } from '../interfaces/source-provider.interface';
import type { SourceProvider, SourceSearchContext } from '../types/source.types';
import { SourceNormalizerService } from './source-normalizer.service';

@Injectable()
export class SourceDiscoveryService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(SOURCE_PROVIDER) private readonly provider: SourceProvider,
    private readonly normalizer: SourceNormalizerService,
    private readonly usage: UsageService,
    private readonly providerObservability: ProviderObservabilityService,
    private readonly requestContext: RequestContextService,
  ) {}

  async discover(executionId: string, organizationId: string, plan: SearchPlan, trace: Pick<SourceSearchContext, 'requestId' | 'correlationId'> = {}) {
    const currentContext = this.requestContext.get();
    const context: SourceSearchContext = { searchExecutionId: executionId, organizationId, requestId: trace.requestId ?? currentContext?.requestId, correlationId: trace.correlationId ?? currentContext?.correlationId };
    await this.audit(organizationId, executionId, 'SOURCE_SEARCH_STARTED');
    await this.usage.checkRequestRate(organizationId, undefined, 'DISCOVERY');
    try {
      const result = await this.providerObservability.track(this.provider.getProviderName(), 'DISCOVERY', async () => ({ value: await this.provider.search(plan, context) }));
      let candidates = 0;

      for (const raw of result.results) {
        try {
          const normalized = this.normalizer.normalize(raw);
          const company = await this.upsertCompany(organizationId, this.provider.getSourceType(), normalized);
          const sourceRecord = await this.upsertSourceRecord(organizationId, executionId, company.id, this.provider.getSourceType(), normalized, context);
          await this.createEvidence(company.id, sourceRecord.id, normalized);
          candidates += 1;
        } catch (error) {
          await this.audit(organizationId, executionId, 'SOURCE_RESULT_REJECTED', undefined, { reason: error instanceof Error ? error.name : 'unknown' });
        }
      }

      await this.usage.recordUsage({ organizationId, operation: 'DISCOVERY', provider: this.provider.getProviderName(), resourceType: 'search_execution', resourceId: executionId, units: 1, status: 'COMPLETED', requestId: context.requestId, metadata: { candidates } });
      await this.audit(organizationId, executionId, 'CANDIDATES_DISCOVERED', undefined, { count: String(candidates), provider: this.provider.getProviderName() });
      await this.audit(organizationId, executionId, 'SOURCE_SEARCH_COMPLETED', undefined, { count: String(candidates), provider: this.provider.getProviderName() });
      return { candidates };
    } catch (error) {
      await this.usage.recordUsage({ organizationId, operation: 'DISCOVERY', provider: this.provider.getProviderName(), resourceType: 'search_execution', resourceId: executionId, units: 1, status: 'FAILED', requestId: context.requestId });
      throw error;
    }
  }

  async listCandidates(executionId: string, organizationId: string, page: number, limit: number) {
    const offset = (page - 1) * limit;
    const where = and(
      eq(sourceRecords.organizationId, organizationId),
      eq(sourceRecords.searchExecutionId, executionId),
    );
    const [items, count] = await Promise.all([
      this.db.select({
        company: companies,
        location: companyLocations,
        source: sourceRecords,
      }).from(sourceRecords)
        .innerJoin(companies, eq(companies.id, sourceRecords.companyId))
        .leftJoin(companyLocations, and(eq(companyLocations.companyId, companies.id), eq(companyLocations.isPrimary, true)))
        .where(where)
        .limit(limit)
        .offset(offset),
      this.db.select({ count: sql<number>`count(*)::int` }).from(sourceRecords).where(where),
    ]);
    return { items, total: count[0]?.count ?? 0, page, limit };
  }

  private async upsertCompany(organizationId: string, provider: string, result: ReturnType<SourceNormalizerService['normalize']>) {
    const website = result.website;
    const [existing] = await this.db.select({ company: companies }).from(companies)
      .leftJoin(companyLocations, eq(companyLocations.companyId, companies.id))
      .where(and(
        eq(companies.organizationId, organizationId),
        or(
          ...(provider === 'google_places' ? [eq(companies.googlePlaceId, result.externalId)] : []),
          ...(website ? [eq(companies.website, website)] : []),
          and(
            ilike(companies.name, result.name),
            result.address?.state ? eq(companyLocations.state, result.address.state) : isNull(companyLocations.state),
          ),
        ),
      )).limit(1);

    if (existing?.company) {
      const [updated] = await this.db.update(companies).set({
        ...(result.website ? { website: result.website } : {}),
        ...(result.phone ? { phone: result.phone } : {}),
        ...(result.category ? { category: result.category } : {}),
        updatedAt: new Date(),
      }).where(eq(companies.id, existing.company.id)).returning();
      return updated ?? existing.company;
    }
    const [company] = await this.db.insert(companies).values({
      organizationId,
      name: result.name,
      website,
      phone: result.phone,
      category: result.category,
      ...(provider === 'google_places' ? { googlePlaceId: result.externalId } : {}),
      googleMapsUrl: result.sourceUrl,
      verificationStatus: 'NOT_VERIFIED',
    }).returning();

    if (result.address) {
      await this.db.insert(companyLocations).values({
        companyId: company.id,
        addressLine1: result.address.addressLine1,
        addressLine2: result.address.addressLine2,
        city: result.address.city,
        state: result.address.state,
        postalCode: result.address.postalCode,
        country: result.address.country,
        latitude: result.address.latitude?.toString(),
        longitude: result.address.longitude?.toString(),
        isPrimary: true,
      });
    }
    return company;
  }

  private async upsertSourceRecord(organizationId: string, executionId: string, companyId: string, provider: string, result: ReturnType<SourceNormalizerService['normalize']>, context: SourceSearchContext) {
    const [existing] = await this.db.select({ id: sourceRecords.id }).from(sourceRecords).where(and(
      eq(sourceRecords.organizationId, organizationId),
      eq(sourceRecords.searchExecutionId, executionId),
      eq(sourceRecords.sourceType, provider),
      eq(sourceRecords.externalId, result.externalId),
    )).limit(1);
    if (existing) return existing;
    const [record] = await this.db.insert(sourceRecords).values({
      organizationId,
      searchExecutionId: executionId,
      companyId,
      sourceType: provider,
      sourceName: provider,
      sourceUrl: result.sourceUrl,
      externalId: result.externalId,
      requestId: context.requestId,
      correlationId: context.correlationId,
      retrievedAt: new Date(),
      rawData: result.rawData,
    }).returning();
    return record;
  }

  private async createEvidence(companyId: string, sourceRecordId: string, result: ReturnType<SourceNormalizerService['normalize']>) {
    const facts = [result.name, result.website, result.phone, result.category, result.address?.addressLine1, result.address?.city, result.address?.state, result.address?.postalCode].filter(Boolean).join(' | ');
    if (!facts) return;
    await this.db.insert(leadEvidence).values({ companyId, sourceRecordId, evidenceType: 'PROVIDER_RESULT', sourceUrl: result.sourceUrl, evidenceText: facts, evidenceTimestamp: new Date(), metadata: { externalId: result.externalId } });
  }

  private async audit(organizationId: string, entityId: string, action: string, userId?: string, metadata?: Record<string, string>) {
    await this.db.insert(auditLogs).values({ organizationId, entityId, userId, action, entityType: 'search_execution', metadata });
  }
}
