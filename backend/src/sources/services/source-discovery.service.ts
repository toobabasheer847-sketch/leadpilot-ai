import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import { DRIZZLE } from '../../database/database.constants';
import type { Database } from '../../database/database.types';
import { auditLogs, companies, companyLocations, sourceRecords } from '../../database/schema/schema';
import { SearchPlan } from '../../search/types/search-plan.types';
import { SOURCE_PROVIDER } from '../interfaces/source-provider.interface';
import type { SourceProvider, SourceSearchContext } from '../types/source.types';
import { SourceNormalizerService } from './source-normalizer.service';

@Injectable()
export class SourceDiscoveryService {
  private readonly logger = new Logger(SourceDiscoveryService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(SOURCE_PROVIDER) private readonly provider: SourceProvider,
    private readonly normalizer: SourceNormalizerService,
  ) {}

  async discover(executionId: string, organizationId: string, plan: SearchPlan) {
    const context: SourceSearchContext = { searchExecutionId: executionId, organizationId };
    await this.audit(organizationId, executionId, 'SOURCE_SEARCH_STARTED');
    const result = await this.provider.search(plan, context);
    let candidates = 0;

    for (const raw of result.results) {
      const normalized = this.normalizer.normalize(raw);
      if (!normalized.externalId || normalized.name === 'Not Found') continue;
      const company = await this.upsertCompany(organizationId, result.provider, normalized);
      await this.upsertSourceRecord(organizationId, executionId, company.id, result.provider, normalized);
      candidates += 1;
    }

    await this.audit(organizationId, executionId, 'CANDIDATES_DISCOVERED', undefined, { count: String(candidates), provider: result.provider });
    await this.audit(organizationId, executionId, 'SOURCE_SEARCH_COMPLETED', undefined, { count: String(candidates), provider: result.provider });
    return { candidates };
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

    if (existing?.company) return existing.company;
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

  private async upsertSourceRecord(organizationId: string, executionId: string, companyId: string, provider: string, result: ReturnType<SourceNormalizerService['normalize']>) {
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
      rawData: result.rawData,
    }).returning();
    return record;
  }

  private async audit(organizationId: string, entityId: string, action: string, userId?: string, metadata?: Record<string, string>) {
    await this.db.insert(auditLogs).values({ organizationId, entityId, userId, action, entityType: 'search_execution', metadata });
  }
}
