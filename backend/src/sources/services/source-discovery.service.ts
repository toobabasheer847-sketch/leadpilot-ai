import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import { DRIZZLE } from '../../database/database.constants';
import type { Database } from '../../database/database.types';
import { auditLogs, companies, companyLocations, leadEvidence, sourceRecords } from '../../database/schema/schema';
import { ProviderObservabilityService } from '../../common/observability/provider-observability.service';
import { RequestContextService } from '../../common/observability/request-context.service';
import { UsageService } from '../../usage/usage.service';
import { SearchPlan } from '../../search/types/search-plan.types';
import {
  countShortfall,
  discoveryAcceptanceCap,
  discoveryTarget,
  explicitResultCount,
  resolveCountIntent,
} from '../../search/search-plan.limits';
import { toCountryCode } from '../location/location-evidence';
import { isRecoverableDiscoveryError, SourceProviderError } from '../providers/source-provider.error';
import { SOURCE_PROVIDER } from '../interfaces/source-provider.interface';
import type { NormalizedSourceResult, SourceProvider, SourceSearchContext } from '../types/source.types';
import { SourceNormalizerService } from './source-normalizer.service';
import { fillEmptyCompanyFields, phoneMatchKey } from './company-field-merge';
import { isPersistableDiscoveryCandidate } from './discovery-candidate.gate';
import { discoveryProviderFailure, resolveDiscoveryFallback } from './discovery-fallback';
import { WebSearchCompanyDiscovery } from '../providers/web-search/web-search-company.discovery';

export function canAttachDiscoveryToOrganization(companyOrganizationId: string, requestOrganizationId: string): boolean {
  return companyOrganizationId.length > 0 && companyOrganizationId === requestOrganizationId;
}

/** A shared name is only a match when both records name the same city. */
export function canMatchDiscoveredCompanyByName(address?: { city?: string | null; state?: string | null }): boolean {
  return Boolean(address?.city?.trim());
}

/** Far-apart coordinates are different offices, even when a previous record reused the name. */
export function discoveredLocationsAgree(
  existingLatitude?: string | number | null,
  existingLongitude?: string | number | null,
  latitude?: number,
  longitude?: number,
  existingCity?: string | null,
  city?: string | null,
): boolean {
  if (existingCity?.trim() && city?.trim() && existingCity.trim().toLowerCase() !== city.trim().toLowerCase()) return false;
  const existingLat = existingLatitude == null || existingLatitude === '' ? undefined : Number(existingLatitude);
  const existingLon = existingLongitude == null || existingLongitude === '' ? undefined : Number(existingLongitude);
  if (existingLat == null || existingLon == null || !Number.isFinite(existingLat) || !Number.isFinite(existingLon)) return true;
  if (typeof latitude !== 'number' || typeof longitude !== 'number') return true;
  return Math.abs(existingLat - latitude) <= 0.02 && Math.abs(existingLon - longitude) <= 0.02;
}

@Injectable()
export class SourceDiscoveryService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(SOURCE_PROVIDER) private readonly provider: SourceProvider,
    private readonly normalizer: SourceNormalizerService,
    private readonly usage: UsageService,
    private readonly providerObservability: ProviderObservabilityService,
    private readonly requestContext: RequestContextService,
    private readonly webDiscovery: WebSearchCompanyDiscovery,
    private readonly config: ConfigService,
  ) {}

  async discover(executionId: string, organizationId: string, plan: SearchPlan, trace: Pick<SourceSearchContext, 'requestId' | 'correlationId'> = {}) {
    const currentContext = this.requestContext.get();
    const context: SourceSearchContext = { searchExecutionId: executionId, organizationId, requestId: trace.requestId ?? currentContext?.requestId, correlationId: trace.correlationId ?? currentContext?.correlationId };
    await this.audit(organizationId, executionId, 'SOURCE_SEARCH_STARTED');
    await this.usage.checkRequestRate(organizationId, undefined, 'DISCOVERY');
    const target = discoveryTarget(plan);
    const explicit = explicitResultCount(plan);
    const acceptanceCap = discoveryAcceptanceCap(plan);
    const countIntent = resolveCountIntent(plan) ?? null;
    const synthetic = this.provider.metadata().synthetic;
    const refillRounds = Math.max(0, this.config.get<number>('sourceProvider.discoveryRefillRounds') ?? 0);
    let rejected = 0;
    let duplicates = 0;
    let providerQueries = 0;
    let primaryResults: NormalizedSourceResult[] = [];
    let primaryError: string | null = null;
    try {
      const result = await this.providerObservability.track(this.provider.providerName(), 'DISCOVERY', async () => ({ value: await this.provider.searchBusinesses(plan, context) }));
      primaryResults = result.results.slice(0, acceptanceCap);
      if ((result.results.length ?? 0) > primaryResults.length) {
        rejected += result.results.length - primaryResults.length;
      }
      primaryError = result.providerError ?? null;
      rejected += result.rejectedCandidates ?? 0;
      duplicates += result.duplicatesRemoved ?? 0;
      providerQueries += result.queriesRun ?? 0;
    } catch (error) {
      if (!isRecoverableDiscoveryError(error)) throw error;
      primaryError = error.message;
    }
    if (primaryError) {
      await this.audit(organizationId, executionId, 'SOURCE_PROVIDER_PARTIAL', undefined, {
        provider: this.provider.providerName(),
        error: primaryError,
      });
    }

    const resolved = resolveDiscoveryFallback({
      primary: { results: primaryResults, error: primaryError },
      web: { results: [], error: null },
    });
    duplicates += resolved.duplicatesRemoved;
    const cappedPrimary = resolved.primary.slice(0, acceptanceCap);
    let candidates = await this.persistResults(organizationId, executionId, this.provider.getSourceType(), cappedPrimary, synthetic, context);
    await this.auditProgress(organizationId, executionId, {
      candidates,
      target: Math.min(target, acceptanceCap),
      requested: explicit ?? null,
      discovered: primaryResults.length,
      accepted: candidates,
      rejected,
      duplicates,
      shortfall: countShortfall(plan, candidates),
      providerQueries,
      phase: 'PRIMARY_PERSISTED',
    });

    let webError: string | null = null;
    let webDiscovered = 0;
    const excludePool: NormalizedSourceResult[] = [...cappedPrimary];

    // Stream web discovery + refill: persist each accepted chunk immediately so hanging SERP
    // queries cannot block COMPANIES_SAVED / WEBSITE_DISCOVERY forever.
    if (!synthetic) {
      let round = 0;
      while (candidates < Math.min(target, acceptanceCap) && round <= refillRounds && !webError) {
        const need = Math.min(target, acceptanceCap) - candidates;
        const before = candidates;
        try {
          const extra = await this.webDiscovery.collect(plan, need, [...excludePool], round, {
            onBatch: async (batch) => {
              const added = await this.persistResults(organizationId, executionId, 'web_search', batch, false, context);
              candidates += added;
              webDiscovered += batch.length;
              await this.auditProgress(organizationId, executionId, {
                candidates,
                target: Math.min(target, acceptanceCap),
                requested: explicit ?? null,
                discovered: primaryResults.length + webDiscovered,
                accepted: candidates,
                rejected,
                duplicates,
                shortfall: countShortfall(plan, candidates),
                providerQueries,
                phase: 'WEB_STREAM_PERSISTED',
                round: String(round),
              });
            },
          });
          excludePool.push(...extra.results);
          providerQueries += extra.queriesRun ?? 0;
          rejected += extra.rejected;
          if (extra.providerError) {
            webError = extra.providerError;
            await this.audit(organizationId, executionId, 'SOURCE_PROVIDER_PARTIAL', undefined, { provider: 'web_search', error: webError });
          }
          if (candidates <= before) break;
        } catch (error) {
          webError = error instanceof Error ? error.message : 'Web company discovery failed.';
          await this.audit(organizationId, executionId, 'SOURCE_PROVIDER_PARTIAL', undefined, { provider: 'web_search', error: webError });
          break;
        }
        round += 1;
      }
    }

    const failure = discoveryProviderFailure(
      candidates,
      this.provider.providerName(),
      primaryError,
      synthetic ? null : { error: webError },
    );
    if (failure) {
      await this.usage.recordUsage({ organizationId, operation: 'DISCOVERY', provider: this.provider.providerName(), resourceType: 'search_execution', resourceId: executionId, units: 1, status: 'FAILED', requestId: context.requestId });
      throw new SourceProviderError(discoveryFailureCode(failure), failure, true);
    }

    const shortfall = countShortfall(plan, candidates);
    const remaining = Math.max(0, (explicit ?? target) - candidates);
    const discovered = primaryResults.length + webDiscovered;
    const unresolved = (plan.unresolvedRequirements ?? plan.unresolvedCriteria ?? [])
      .map((item) => item.text)
      .filter(Boolean)
      .slice(0, 8)
      .join(' | ');
    await this.usage.recordUsage({ organizationId, operation: 'DISCOVERY', provider: this.provider.providerName(), resourceType: 'search_execution', resourceId: executionId, units: 1, status: 'COMPLETED', requestId: context.requestId, metadata: { candidates, countIntent, shortfall } });
    await this.audit(organizationId, executionId, 'CANDIDATES_DISCOVERED', undefined, {
      count: String(candidates),
      requested: explicit === undefined ? '' : String(explicit),
      countIntent: countIntent ?? '',
      discovered: String(discovered),
      accepted: String(candidates),
      rejected: String(rejected),
      duplicatesRemoved: String(duplicates),
      persisted: String(candidates),
      qualified: '', // filled later by qualification stage; never claim requested == qualified here
      shortfall: String(shortfall),
      remainingTarget: String(remaining),
      providerQueries: String(providerQueries),
      provider: this.provider.providerName(),
      primaryError: primaryError ?? '',
      webError: webError ?? '',
      unresolvedRequirements: unresolved,
      exclusions: (plan.exclusions ?? []).slice(0, 8).join(' | '),
      status: shortfall > 0 ? 'SHORTFALL' : 'COMPLETE',
    });
    await this.audit(organizationId, executionId, 'COMPANIES_SAVED', undefined, { count: String(candidates), provider: this.provider.providerName() });
    await this.audit(organizationId, executionId, 'SOURCE_SEARCH_COMPLETED', undefined, { count: String(candidates), provider: this.provider.providerName(), countIntent: countIntent ?? '' });
    return {
      candidates,
      requested: explicit ?? null,
      countIntent,
      discovered,
      accepted: candidates,
      persisted: candidates,
      rejected,
      duplicatesRemoved: duplicates,
      shortfall,
      providerQueries,
      primaryError,
      webError,
    };
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
    const city = result.address?.city?.trim();
    const state = result.address?.state?.trim();
    const nameMatch = canMatchDiscoveredCompanyByName(result.address)
      ? and(
        ilike(companies.name, result.name),
        ilike(companyLocations.city, city as string),
        state ? eq(companyLocations.state, state) : isNull(companyLocations.state),
      )
      : undefined;
    const identityMatches = [
      ...(provider === 'google_places' ? [eq(companies.googlePlaceId, result.externalId)] : []),
      ...(website ? [eq(companies.website, website)] : []),
      ...(phoneMatchKey(result.phone) ? [eq(companies.phone, result.phone as string)] : []),
      ...(nameMatch ? [nameMatch] : []),
    ];
    const linked = await this.findCompanyByExternalId(organizationId, provider, result.externalId);
    const linkedHere = linked && discoveredLocationsAgree(linked.latitude, linked.longitude, result.address?.latitude, result.address?.longitude, linked.city, result.address?.city)
      ? linked
      : undefined;
    const [found] = linkedHere
      ? [linkedHere]
      : identityMatches.length === 0
        ? []
        : await this.db.select({
          company: companies,
          latitude: companyLocations.latitude,
          longitude: companyLocations.longitude,
          city: companyLocations.city,
        }).from(companies)
          .leftJoin(companyLocations, eq(companyLocations.companyId, companies.id))
          .where(and(
            eq(companies.organizationId, organizationId),
            identityMatches.length === 1 ? identityMatches[0] : or(...identityMatches),
          )).limit(1);
    const existing = found && discoveredLocationsAgree(found.latitude, found.longitude, result.address?.latitude, result.address?.longitude, found.city, result.address?.city)
      ? found
      : undefined;

    if (existing?.company && canAttachDiscoveryToOrganization(existing.company.organizationId, organizationId)) {
      const updates = fillEmptyCompanyFields(existing.company, {
        website: result.website,
        phone: result.phone,
        email: result.email,
        category: result.category,
        googlePlaceId: provider === 'google_places' ? result.externalId : null,
      });
      if (Object.keys(updates).length === 0 && (existing.company.googleMapsUrl || provider !== 'google_places')) return existing.company;
      const [updated] = await this.db.update(companies).set({
        ...updates,
        ...(provider === 'google_places' && !existing.company.googleMapsUrl ? { googleMapsUrl: result.sourceUrl } : {}),
        updatedAt: new Date(),
      }).where(eq(companies.id, existing.company.id)).returning();
      return updated ?? existing.company;
    }
    const [company] = await this.db.insert(companies).values({
      organizationId,
      name: result.name,
      website,
      phone: result.phone,
      email: result.email,
      category: result.category,
      ...(provider === 'google_places' ? { googlePlaceId: result.externalId, googleMapsUrl: result.sourceUrl } : {}),
      verificationStatus: 'NOT_VERIFIED',
      investorType: null,
    }).returning();

    if (result.address) {
      const location = storableLocation(result.address);
      if (location) {
        await this.db.insert(companyLocations).values({
          companyId: company.id,
          ...location,
          isPrimary: true,
        });
      }
    }
    return company;
  }

  private async persistResults(organizationId: string, executionId: string, provider: string, results: ReturnType<SourceNormalizerService['normalize']>[], synthetic: boolean, context: SourceSearchContext) {
    let accepted = 0;
    for (const raw of results) {
      try {
        const normalized = this.normalizer.normalize(raw);
        const gate = isPersistableDiscoveryCandidate({ website: normalized.website, sourceUrl: normalized.sourceUrl });
        if (!gate.ok) {
          await this.audit(organizationId, executionId, 'SOURCE_RESULT_REJECTED', undefined, { reason: gate.reason, sourceUrl: normalized.sourceUrl.slice(0, 200) });
          continue;
        }
        const company = await this.upsertCompany(organizationId, provider, normalized);
        const alreadyLinked = await this.companyAlreadyInExecution(organizationId, executionId, company.id);
        const sourceRecord = await this.upsertSourceRecord(organizationId, executionId, company.id, provider, normalized, context);
        if (!synthetic) await this.createEvidence(company.id, sourceRecord.id, normalized, provider);
        if (!alreadyLinked) accepted += 1;
      } catch (error) {
        await this.audit(organizationId, executionId, 'SOURCE_RESULT_REJECTED', undefined, { reason: error instanceof Error ? error.name : 'unknown' });
      }
    }
    return accepted;
  }

  private async companyAlreadyInExecution(organizationId: string, executionId: string, companyId: string) {
    const [row] = await this.db.select({ id: sourceRecords.id }).from(sourceRecords).where(and(
      eq(sourceRecords.organizationId, organizationId),
      eq(sourceRecords.searchExecutionId, executionId),
      eq(sourceRecords.companyId, companyId),
    )).limit(1);
    return Boolean(row);
  }

  private async findCompanyByExternalId(organizationId: string, provider: string, externalId: string) {
    if (!externalId) return undefined;
    const [linked] = await this.db.select({
      company: companies,
      latitude: companyLocations.latitude,
      longitude: companyLocations.longitude,
      city: companyLocations.city,
    }).from(sourceRecords)
      .innerJoin(companies, eq(companies.id, sourceRecords.companyId))
      .leftJoin(companyLocations, and(eq(companyLocations.companyId, companies.id), eq(companyLocations.isPrimary, true)))
      .where(and(
        eq(sourceRecords.organizationId, organizationId),
        eq(companies.organizationId, organizationId),
        eq(sourceRecords.sourceType, provider),
        eq(sourceRecords.externalId, externalId),
      ))
      .limit(1);
    return linked;
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

  private async createEvidence(companyId: string, sourceRecordId: string, result: ReturnType<SourceNormalizerService['normalize']>, provider: string) {
    const snippet = typeof result.rawData?.snippet === 'string' ? result.rawData.snippet : '';
    const facts = [result.name, result.website, result.phone, result.email, result.category, result.address?.addressLine1, result.address?.city, result.address?.state, result.address?.postalCode, snippet].filter(Boolean).join(' | ');
    if (!facts) return;
    const locationEvidence = result.rawData?.locationEvidence;
    await this.db.insert(leadEvidence).values({ companyId, sourceRecordId, evidenceType: 'PROVIDER_RESULT', sourceUrl: result.sourceUrl, evidenceText: facts, evidenceTimestamp: new Date(), provider, metadata: { externalId: result.externalId, verified: false, ...(locationEvidence ? { locationEvidence } : {}) } });
  }

  private async auditProgress(
    organizationId: string,
    executionId: string,
    state: {
      candidates: number;
      target: number;
      requested: number | null;
      discovered: number;
      accepted: number;
      rejected: number;
      duplicates: number;
      shortfall: number;
      providerQueries: number;
      phase: string;
      round?: string;
    },
  ) {
    await this.audit(organizationId, executionId, 'DISCOVERY_PROGRESS', undefined, {
      requested: state.requested === null ? '' : String(state.requested),
      discovered: String(state.discovered),
      accepted: String(state.accepted),
      persisted: String(state.candidates),
      target: String(state.target),
      remainingTarget: String(Math.max(0, state.target - state.candidates)),
      rejected: String(state.rejected),
      duplicates: String(state.duplicates),
      shortfall: String(state.shortfall),
      providerQueries: String(state.providerQueries),
      phase: state.phase,
      ...(state.round ? { round: state.round } : {}),
    });
  }

  private async audit(organizationId: string, entityId: string, action: string, userId?: string, metadata?: Record<string, string>) {
    await this.db.insert(auditLogs).values({ organizationId, entityId, userId, action, entityType: 'search_execution', metadata });
  }
}

function discoveryFailureCode(failure: string): 'PROVIDER_RATE_LIMITED' | 'PROVIDER_TIMEOUT' | 'PROVIDER_QUOTA_EXCEEDED' | 'PROVIDER_UNAVAILABLE' {
  if (/plan limit|pay-as-you-go limit|quota|HTTP 432|HTTP 433/i.test(failure)) return 'PROVIDER_QUOTA_EXCEEDED';
  if (/rate limit|429/i.test(failure)) return 'PROVIDER_RATE_LIMITED';
  if (/timed out|timeout/i.test(failure)) return 'PROVIDER_TIMEOUT';
  return 'PROVIDER_UNAVAILABLE';
}

function columnText(value: string | null | undefined, max: number): string | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > max) return null;
  return trimmed;
}

/** Country is varchar(2). A longer place name is stored as an ISO code, or omitted so the company is not dropped. */
function storableLocation(address: {
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
  latitude?: number;
  longitude?: number;
}) {
  const latitude = typeof address.latitude === 'number' && Number.isFinite(address.latitude) ? address.latitude.toString() : null;
  const longitude = typeof address.longitude === 'number' && Number.isFinite(address.longitude) ? address.longitude.toString() : null;
  const location = {
    addressLine1: columnText(address.addressLine1, 255),
    addressLine2: columnText(address.addressLine2, 255),
    city: columnText(address.city, 120),
    state: columnText(address.state, 100),
    postalCode: columnText(address.postalCode, 20),
    country: toCountryCode(address.country) ?? null,
    latitude,
    longitude,
  };
  return Object.values(location).some((value) => value != null && value !== '') ? location : null;
}
