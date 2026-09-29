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
  discoveryQueryBudget,
  discoveryTarget,
  explicitResultCount,
  resolveCountIntent,
} from '../../search/search-plan.limits';
import { toCountryCode } from '../location/location-evidence';
import { isRecoverableDiscoveryError, SourceProviderError } from '../providers/source-provider.error';
import { DISCOVERY_PROVIDER_CHAIN, SOURCE_PROVIDER } from '../interfaces/source-provider.interface';
import type { NormalizedSourceResult, SourceProvider, SourceSearchContext } from '../types/source.types';
import { SourceNormalizerService } from './source-normalizer.service';
import { fillEmptyCompanyFields, phoneMatchKey } from './company-field-merge';
import { isPersistableDiscoveryCandidate } from './discovery-candidate.gate';
import { dedupeDiscoveryCandidates } from './discovery-fallback';
import { DiscoveryExecutionCircuit } from './discovery-execution-circuit';
import {
  aggregateDiscoveryFailure,
  classifyDiscoveryProviderOutcome,
  discoveryCompletedWithLimitationsMessage,
  discoveryFailureCodeFromAttempts,
  discoveryProgressSummary,
  DISCOVERY_PROVIDER_CIRCUIT_OUTCOMES,
  type DiscoveryProviderAttempt,
} from './discovery-provider-outcome';
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
    @Inject(DISCOVERY_PROVIDER_CHAIN) private readonly providerChain: SourceProvider[],
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
    const seek = Math.min(target, acceptanceCap);
    const countIntent = resolveCountIntent(plan) ?? null;
    const mapProviders = this.providerChain.length ? this.providerChain : [this.provider];
    const synthetic = mapProviders.some((entry) => entry.metadata().synthetic);
    const refillRounds = Math.max(0, this.config.get<number>('sourceProvider.discoveryRefillRounds') ?? 0);
    const circuit = new DiscoveryExecutionCircuit(executionId, organizationId);
    const attempts: DiscoveryProviderAttempt[] = [];
    let rejected = 0;
    let duplicates = 0;
    let providerQueries = 0;
    let queriesSkipped = 0;
    let mapDiscovered = 0;
    let candidates = 0;
    let primaryError: string | null = null;
    const excludePool: NormalizedSourceResult[] = [];

    for (const mapProvider of mapProviders) {
      if (candidates >= seek) break;
      const providerName = mapProvider.providerName();
      if (circuit.isUnavailable(providerName)) {
        const remainingBudget = Math.max(0, discoveryQueryBudget(seek) - 0);
        queriesSkipped += remainingBudget;
        attempts.push({
          provider: providerName,
          outcome: circuit.reason(providerName)?.outcome ?? 'FATAL_ERROR',
          message: circuit.reason(providerName)?.message ?? 'Provider unavailable for this execution.',
          resultsCount: 0,
          queriesRun: 0,
          queriesSkipped: remainingBudget,
        });
        continue;
      }

      let providerResults: NormalizedSourceResult[] = [];
      let providerError: string | null = null;
      let errorCode: string | null = null;
      let queriesRun = 0;
      try {
        const result = await this.providerObservability.track(providerName, 'DISCOVERY', async () => ({ value: await mapProvider.searchBusinesses(plan, context) }));
        const room = Math.max(0, acceptanceCap - candidates);
        const { accepted, duplicatesRemoved } = dedupeDiscoveryCandidates(excludePool, result.results.slice(0, room));
        if ((result.results.length ?? 0) > accepted.length + duplicatesRemoved) {
          rejected += result.results.length - accepted.length - duplicatesRemoved;
        }
        providerResults = accepted;
        providerError = result.providerError ?? null;
        rejected += result.rejectedCandidates ?? 0;
        duplicates += (result.duplicatesRemoved ?? 0) + duplicatesRemoved;
        queriesRun = result.queriesRun ?? 0;
        providerQueries += queriesRun;
      } catch (error) {
        if (!isRecoverableDiscoveryError(error)) throw error;
        providerError = error.message;
        errorCode = error.code;
      }

      const outcome = classifyDiscoveryProviderOutcome({
        resultsCount: providerResults.length,
        error: providerError,
        errorCode,
      });
      const budget = discoveryQueryBudget(seek);
      const skipped = providerError && DISCOVERY_PROVIDER_CIRCUIT_OUTCOMES.has(outcome)
        ? Math.max(0, budget - queriesRun)
        : 0;
      queriesSkipped += skipped;
      attempts.push({
        provider: providerName,
        outcome,
        message: providerError,
        resultsCount: providerResults.length,
        queriesRun,
        queriesSkipped: skipped,
      });
      circuit.trip(providerName, outcome, providerError);

      if (providerError) {
        if (!primaryError) primaryError = providerError;
        await this.audit(organizationId, executionId, 'SOURCE_PROVIDER_PARTIAL', undefined, {
          provider: providerName,
          error: providerError,
          outcome,
          executionId,
          organizationId,
        });
      }

      if (providerResults.length) {
        excludePool.push(...providerResults);
        mapDiscovered += providerResults.length;
        const added = await this.persistResults(organizationId, executionId, mapProvider.getSourceType(), providerResults, synthetic, context);
        candidates += added;
      }

      await this.auditProgress(organizationId, executionId, {
        candidates,
        target: seek,
        requested: explicit ?? null,
        discovered: mapDiscovered,
        accepted: candidates,
        rejected,
        duplicates,
        shortfall: countShortfall(plan, candidates),
        providerQueries,
        queriesSkipped,
        phase: 'MAP_PROVIDER_PERSISTED',
        attempts,
      });
    }

    let webError: string | null = null;
    let webDiscovered = 0;

    // Stream web discovery + refill: persist each accepted chunk immediately so hanging SERP
    // queries cannot block COMPANIES_SAVED / WEBSITE_DISCOVERY forever.
    if (!synthetic) {
      let round = 0;
      let webQueriesRun = 0;
      let webQueriesSkipped = 0;
      let webResultsCount = 0;
      while (candidates < seek && round <= refillRounds && !circuit.isUnavailable('web_search')) {
        const need = seek - candidates;
        const before = candidates;
        const roundBudget = discoveryQueryBudget(need);
        try {
          const extra = await this.webDiscovery.collect(plan, need, [...excludePool], round, {
            onBatch: async (batch) => {
              const { accepted, duplicatesRemoved } = dedupeDiscoveryCandidates(excludePool, batch);
              duplicates += duplicatesRemoved;
              if (!accepted.length) return;
              excludePool.push(...accepted);
              const added = await this.persistResults(organizationId, executionId, 'web_search', accepted, false, context);
              candidates += added;
              webDiscovered += accepted.length;
              webResultsCount += accepted.length;
              await this.auditProgress(organizationId, executionId, {
                candidates,
                target: seek,
                requested: explicit ?? null,
                discovered: mapDiscovered + webDiscovered,
                accepted: candidates,
                rejected,
                duplicates,
                shortfall: countShortfall(plan, candidates),
                providerQueries,
                queriesSkipped,
                phase: 'WEB_STREAM_PERSISTED',
                round: String(round),
                attempts,
              });
            },
          });
          excludePool.push(...extra.results.filter((result) => !excludePool.some((existing) => existing.externalId === result.externalId)));
          const run = extra.queriesRun ?? 0;
          webQueriesRun += run;
          providerQueries += run;
          rejected += extra.rejected;
          if (extra.providerError) {
            webError = extra.providerError;
            const outcome = classifyDiscoveryProviderOutcome({ resultsCount: webResultsCount, error: webError });
            const skipped = Math.max(0, roundBudget - run);
            webQueriesSkipped += skipped;
            queriesSkipped += skipped;
            // Remaining refill rounds are not issued once the web circuit opens.
            const remainingRounds = Math.max(0, refillRounds - round);
            if (remainingRounds > 0) {
              const skippedRounds = remainingRounds * roundBudget;
              webQueriesSkipped += skippedRounds;
              queriesSkipped += skippedRounds;
            }
            circuit.trip('web_search', outcome, webError);
            await this.audit(organizationId, executionId, 'SOURCE_PROVIDER_PARTIAL', undefined, {
              provider: 'web_search',
              error: webError,
              outcome,
              executionId,
              organizationId,
            });
          }
          if (candidates <= before) break;
        } catch (error) {
          webError = error instanceof Error ? error.message : 'Web company discovery failed.';
          const outcome = classifyDiscoveryProviderOutcome({ resultsCount: webResultsCount, error: webError });
          circuit.trip('web_search', outcome, webError);
          await this.audit(organizationId, executionId, 'SOURCE_PROVIDER_PARTIAL', undefined, {
            provider: 'web_search',
            error: webError,
            outcome,
            executionId,
            organizationId,
          });
          break;
        }
        round += 1;
      }

      if (webQueriesRun > 0 || webError || webResultsCount > 0 || (!circuit.isUnavailable('web_search') && mapProviders.length > 0)) {
        const webOutcome = classifyDiscoveryProviderOutcome({ resultsCount: webResultsCount, error: webError });
        // Record web even when never called only if we intentionally skipped due to circuit before any attempt.
        if (webQueriesRun > 0 || webError || webResultsCount > 0) {
          attempts.push({
            provider: 'web_search',
            outcome: webOutcome,
            message: webError,
            resultsCount: webResultsCount,
            queriesRun: webQueriesRun,
            queriesSkipped: webQueriesSkipped,
          });
        } else if (candidates < seek) {
          // Web was eligible but produced nothing without error (honest empty / no progress).
          attempts.push({
            provider: 'web_search',
            outcome: 'EMPTY',
            message: null,
            resultsCount: 0,
            queriesRun: webQueriesRun,
            queriesSkipped: webQueriesSkipped,
          });
        }
      }
    }

    const failure = aggregateDiscoveryFailure(candidates, attempts);
    if (failure) {
      await this.usage.recordUsage({ organizationId, operation: 'DISCOVERY', provider: this.provider.providerName(), resourceType: 'search_execution', resourceId: executionId, units: 1, status: 'FAILED', requestId: context.requestId });
      throw new SourceProviderError(discoveryFailureCodeFromAttempts(attempts), failure, true);
    }

    const shortfall = countShortfall(plan, candidates);
    const remaining = Math.max(0, (explicit ?? target) - candidates);
    const discovered = mapDiscovered + webDiscovered;
    const progress = discoveryProgressSummary(attempts);
    const limitations = discoveryCompletedWithLimitationsMessage(candidates, explicit ?? null, attempts);
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
      queriesSkipped: String(queriesSkipped),
      providersAttempted: String(progress.providersAttempted),
      providersSucceeded: String(progress.providersSucceeded),
      providersEmpty: String(progress.providersEmpty),
      providersUnavailable: String(progress.providersUnavailable),
      providersQuotaExceeded: String(progress.providersQuotaExceeded),
      providersFailed: String(progress.providersFailed),
      providerStatusSummary: progress.providerStatusSummary,
      discoveryStatus: shortfall > 0
        ? (limitations ? 'COMPLETED_WITH_SHORTFALL' : 'SHORTFALL')
        : 'COMPLETE',
      limitationsMessage: limitations ?? '',
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
      queriesSkipped,
      providersAttempted: progress.providersAttempted,
      providersSucceeded: progress.providersSucceeded,
      providersEmpty: progress.providersEmpty,
      providersUnavailable: progress.providersUnavailable,
      providersQuotaExceeded: progress.providersQuotaExceeded,
      providersFailed: progress.providersFailed,
      providerStatusSummary: progress.providerStatusSummary,
      providerAttempts: attempts,
      primaryError,
      webError,
      limitationsMessage: limitations,
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
      queriesSkipped?: number;
      phase: string;
      round?: string;
      attempts?: DiscoveryProviderAttempt[];
    },
  ) {
    const progress = discoveryProgressSummary(state.attempts ?? []);
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
      queriesSkipped: String(state.queriesSkipped ?? progress.queriesSkipped),
      providersAttempted: String(progress.providersAttempted),
      providersSucceeded: String(progress.providersSucceeded),
      providersEmpty: String(progress.providersEmpty),
      providersUnavailable: String(progress.providersUnavailable),
      providersQuotaExceeded: String(progress.providersQuotaExceeded),
      providersFailed: String(progress.providersFailed),
      providerStatusSummary: progress.providerStatusSummary,
      phase: state.phase,
      ...(state.round ? { round: state.round } : {}),
    });
  }

  private async audit(organizationId: string, entityId: string, action: string, userId?: string, metadata?: Record<string, string>) {
    await this.db.insert(auditLogs).values({ organizationId, entityId, userId, action, entityType: 'search_execution', metadata });
  }
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
