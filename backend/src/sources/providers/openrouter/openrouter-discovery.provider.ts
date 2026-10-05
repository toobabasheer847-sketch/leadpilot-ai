import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OutboundRequestError, OutboundRequestService } from '../../../common/outbound-request.service';
import { discoveryTarget } from '../../../search/search-plan.limits';
import type { SearchPlan } from '../../../search/types/search-plan.types';
import {
  collectWebCompanyCandidates,
  type WebCompanySearchFn,
  type WebCompanyCollection,
} from '../web-search/company-discovery.assess';
import type { WebSearchResult } from '../../../enrichment/website/web-search.types';
import type { NormalizedSourceResult, SourceProvider, SourceSearchContext, SourceSearchResult } from '../../types/source.types';
import { SourceProviderError } from '../source-provider.error';
import type { DiscoveryYieldSnapshot } from '../../services/discovery-yield';

const DEFAULT_MODEL = 'openrouter/auto';
const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const MAX_RESULTS = 10;
const CANDIDATES_PER_CHUNK = 10;
const CANDIDATES_PER_LARGE_CHUNK = 15;
const TEXAS_DISCOVERY_CITIES = [
  'Dallas',
  'Houston',
  'Austin',
  'San Antonio',
  'Fort Worth',
  'El Paso',
  'Arlington',
  'Corpus Christi',
  'Plano',
  'Lubbock',
] as const;
const MAX_DISCOVERY_DURATION_MS = 30000;
const MAX_TRANSIENT_RETRIES = 3;
const SUB_QUERY_DELAY_MS = 1000;
const FAILED_CHUNK_DELAY_MS = 3000;
const MAX_DEBUG_RESPONSE_CHARS = 4000;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

interface Citation {
  url: string;
  title: string;
  content: string;
}

interface CompanyRecord {
  company_name: string;
  official_website: string;
  email?: string;
  evidence_url?: string;
  contacts?: unknown[];
  description?: string;
  activity?: string;
  category?: string;
  location?: string;
  snippet?: string;
}

interface ContactRecord {
  full_name?: string;
  title?: string;
  linkedin?: string;
  email?: string;
  linkedin_url?: string;
  linkedinUrl?: string;
  facebook?: string;
  facebook_url?: string;
  facebookUrl?: string;
  instagram?: string;
  instagram_url?: string;
  instagramUrl?: string;
  evidence_url?: string;
}

@Injectable()
export class OpenRouterDiscoveryProvider implements SourceProvider {
  readonly name = 'openrouter';
  private readonly logger = new Logger(OpenRouterDiscoveryProvider.name);
  private readonly apiKey?: string;
  private readonly model: string;
  private readonly baseUrl?: string;
  private readonly timeoutMs: number;
  private readonly retries: number;

  constructor(
    private readonly outbound: OutboundRequestService,
    private readonly config: ConfigService,
  ) {
    this.apiKey = config.get<string>('openRouter.apiKey')?.trim() || undefined;
    this.model = config.get<string>('openRouter.model')?.trim() || DEFAULT_MODEL;
    this.baseUrl = httpsBaseUrl(config.get<string>('openRouter.baseUrl') || DEFAULT_BASE_URL);
    this.timeoutMs = positiveInt(config.get<number>('openRouter.timeoutMs'), 120000);
    this.retries = Math.max(0, Math.min(5, config.get<number>('openRouter.retries') ?? 2));
  }

  providerName() { return this.name; }
  getProviderName() { return this.providerName(); }
  getSourceType() { return this.name; }
  metadata() { return { provider: this.name, sourceType: this.name, synthetic: false }; }

  health() {
    const configured = Boolean(this.apiKey && this.model && this.baseUrl);
    return { name: this.name, configured, enabled: configured };
  }

  search(plan: SearchPlan, context: SourceSearchContext) {
    return this.searchBusinesses(plan, context);
  }

  async searchBusinesses(plan: SearchPlan, context: SourceSearchContext): Promise<SourceSearchResult> {
    if (!this.health().configured) {
      throw new SourceProviderError('PROVIDER_NOT_CONFIGURED', 'OpenRouter discovery is not configured.');
    }

    const chunks: WebCompanyCollection[] = [];
    const results: NormalizedSourceResult[] = [];
    let target = 0;
    let partialError: string | null = null;
    try {
      target = discoveryTarget(plan);
      const concurrency = Math.min(2, positiveInt(
        this.config.get<number>('sourceProvider.discoveryQueryConcurrency')
          ?? this.config.get<number>('sourceProvider.concurrency'),
        1,
      ));
      const maxResults = target >= 100
        ? MAX_RESULTS
        : Math.min(MAX_RESULTS, positiveInt(this.config.get<number>('webSearch.maxResults'), 5));
      const candidateBatchSize = target >= 100 ? CANDIDATES_PER_LARGE_CHUNK : CANDIDATES_PER_CHUNK;
      const texasCitySearch = target >= 100 && isTexasStatePlan(plan);
      const chunkCount = Math.ceil(target / candidateBatchSize);
      const maxChunkAttempts = texasCitySearch
        ? Math.min(10, chunkCount + Math.max(
            1,
            this.config.get<number>('sourceProvider.discoveryMaxConsecutiveFailures') ?? 3,
          ))
        : chunkCount + Math.max(
            1,
            this.config.get<number>('sourceProvider.discoveryMaxConsecutiveFailures') ?? 3,
          );
      let lastChunkError: SourceProviderError | undefined;
      let failedChunks = 0;
      let successfulChunks = 0;
      let previousChunkFailed = false;
      for (let chunkIndex = 0; chunkIndex < maxChunkAttempts && results.length < target; chunkIndex += 1) {
        if (chunkIndex > 0 && !previousChunkFailed) await this.sleep(SUB_QUERY_DELAY_MS);
        previousChunkFailed = false;
        const chunkTarget = Math.min(candidateBatchSize, target - results.length);
        const queryTimeoutMs = Math.max(1, Math.min(MAX_DISCOVERY_DURATION_MS, this.timeoutMs));
        const requestDeadline = Date.now() + queryTimeoutMs;
        const regionalQuery = texasCitySearch ? texasRegionalQuery(plan, chunkIndex) : undefined;
        let lastSearchError: SourceProviderError | undefined;
        const searchText: WebCompanySearchFn = async (query, options) => {
          try {
            const subQuery = regionalQuery ?? query;
            return await this.searchText(
              subQuery,
              plan,
              maxResults,
              chunkTarget,
              requestDeadline,
              options?.signal ?? context.signal,
            );
          } catch (error) {
            if (error instanceof SourceProviderError) {
              lastSearchError = error;
              if (error.code === 'PROVIDER_TIMEOUT') {
                this.logger.warn(JSON.stringify({
                  event: 'discovery.search.query_timed_out',
                  provider: this.name,
                  executionId: context.searchExecutionId,
                  chunk: chunkIndex + 1,
                }));
              }
              throw error;
            }
            this.logger.warn(JSON.stringify({
              event: 'discovery.search.query_failed',
              provider: this.name,
              executionId: context.searchExecutionId,
              chunk: chunkIndex + 1,
              error: error instanceof Error ? error.name : 'unknown',
            }));
            lastSearchError = new SourceProviderError('PROVIDER_UNAVAILABLE', 'OpenRouter discovery query failed.');
            throw lastSearchError;
          }
        };
        const collection = await collectWebCompanyCandidates(plan, chunkTarget, searchText, {
          maxQueries: 1,
          concurrency,
          queryTimeoutMs,
          allowUnqualifiedOpenRouter: true,
          delayMs: Math.max(0, this.config.get<number>('sourceProvider.retryDelayMs') ?? 0),
          maxConsecutiveFailures: Math.max(1, this.config.get<number>('sourceProvider.discoveryMaxConsecutiveFailures') ?? 3),
          exclude: results,
          round: chunkIndex,
        });
        chunks.push(collection);
        if (!collection.providerError) successfulChunks += 1;
        for (const candidate of collection.results) {
          this.logger.debug(`[OpenRouterAssessment] Candidate accepted with PENDING status: ${candidate.name}`);
        }
        results.push(...collection.results.slice(0, target - results.length));
        if (collection.providerError) {
          partialError ??= collection.providerError;
          lastChunkError = lastSearchError;
          failedChunks += 1;
          const retryable = lastSearchError?.code === 'PROVIDER_RATE_LIMITED'
            || lastSearchError?.code === 'PROVIDER_UNAVAILABLE'
            || lastSearchError?.code === 'PROVIDER_TIMEOUT'
            || /rate limit|429|temporarily unavailable|timed out|timeout/i.test(collection.providerError);
          const malformed = lastSearchError?.code === 'PROVIDER_INVALID_RESPONSE';
          if (retryable || (malformed && results.length > 0)) {
            this.logger.warn(JSON.stringify({
              event: retryable ? 'discovery.search.chunk_retryable_failure' : 'discovery.search.chunk_malformed',
              provider: this.name,
              executionId: context.searchExecutionId,
              chunk: chunkIndex + 1,
              failedChunks,
              candidatesRetained: results.length,
            }));
            if (retryable && chunkIndex + 1 < maxChunkAttempts && results.length < target) {
              await this.sleep(FAILED_CHUNK_DELAY_MS);
              previousChunkFailed = true;
            }
            continue;
          }
          if (malformed && lastSearchError) throw lastSearchError;
          if (results.length === 0 && lastSearchError) throw lastSearchError;
          break;
        }
      }
      await this.enrichOpenRouterCandidates(plan, results, context, maxResults);
      const collection = mergeCollections(
        chunks,
        results,
        results.length || successfulChunks ? null : partialError,
      );
      if (collection.providerError && collection.results.length === 0 && lastChunkError
        && failedChunks >= maxChunkAttempts) {
        this.logger.warn(JSON.stringify({
          event: 'discovery.search.all_chunks_failed',
          provider: this.name,
          executionId: context.searchExecutionId,
          failedChunks,
          queriesRun: collection.queriesRun,
        }));
      }
      return this.toSearchResult(collection, context);
    } catch (error) {
      if (error instanceof SourceProviderError) throw error;
      this.logger.warn(JSON.stringify({
        event: 'discovery.search.unexpected_error',
        provider: this.name,
        executionId: context.searchExecutionId,
        error: error instanceof Error ? error.name : 'unknown',
        stack: error instanceof Error ? error.stack : undefined,
        candidatesRetained: results.length,
      }));
      if (results.length > 0) {
        return {
          provider: this.name,
          results,
          rejectedCandidates: 0,
          duplicatesRemoved: 0,
          queriesRun: 0,
          providerError: 'OpenRouter discovery stopped after an unexpected provider error.',
        };
      }
      throw new SourceProviderError('PROVIDER_UNAVAILABLE', 'OpenRouter discovery failed unexpectedly.');
    }
  }

  private toSearchResult(collection: WebCompanyCollection, context: SourceSearchContext): SourceSearchResult {
    this.logger.log(JSON.stringify({
      event: 'discovery.search.completed',
      provider: this.name,
      executionId: context.searchExecutionId,
      queriesRun: collection.queriesRun,
      results: collection.results.length,
      rejectedCandidates: collection.rejected,
    }));
    return {
      provider: this.name,
      results: collection.results,
      rejectedCandidates: collection.rejected,
      duplicatesRemoved: collection.yieldSnapshot?.duplicates ?? 0,
      queriesRun: collection.queriesRun,
      ...(collection.providerError ? { providerError: collection.providerError } : {}),
    };
  }

  private async enrichOpenRouterCandidates(
    plan: SearchPlan,
    candidates: NormalizedSourceResult[],
    context: SourceSearchContext,
    maxResults: number,
  ): Promise<void> {
    const location = plan.locations.map(formatLocation).filter(Boolean).join('; ') || 'Texas';
    for (const candidate of candidates) {
      const rawData = candidate.rawData ?? {};
      const fields = isRecord(rawData.openRouterFields) ? rawData.openRouterFields : {};
      const owner = typeof fields.personName === 'string' ? fields.personName.trim() : '';
      const query = `Find LinkedIn, Facebook, Instagram profile, and contact email for ${candidate.name}${owner ? ` or owner ${owner}` : ''} in ${location}. Return public source URLs, any public business/contact email, and a named owner/founder with title only when cited.`;
      try {
        const hits = await this.searchText(
          query,
          plan,
          maxResults,
          1,
          Date.now() + Math.max(1, Math.min(MAX_DISCOVERY_DURATION_MS, this.timeoutMs)),
          context.signal,
        );
        const matchedHits = hits.filter((hit) =>
          containsCompanyName(`${hit.title} ${hit.snippet}`, candidate.name)
          || (candidate.website && sameHost(hit.website ?? hit.url, candidate.website)),
        );
        const contacts = matchedHits.flatMap((hit) => hit.extractedContacts ?? []);
        const profiles = matchedHits.flatMap((hit) => hit.socialProfiles ?? []);
        const emails = matchedHits.map((hit) => hit.companyEmail).filter((email): email is string => Boolean(email));
        const mergedProfiles = mergeSocialProfiles(
          Array.isArray(rawData.openRouterSocialProfiles) ? rawData.openRouterSocialProfiles : [],
          profiles,
        );
        const mergedContacts = mergeOpenRouterContacts(
          Array.isArray(rawData.openRouterContacts) ? rawData.openRouterContacts : [],
          contacts,
        );
        const contact = contacts[0];
        candidate.email ??= emails[0];
        candidate.rawData = {
          ...rawData,
          openRouterFields: {
            ...fields,
            personName: (typeof fields.personName === 'string' && fields.personName) || contact?.fullName || null,
            personTitle: (typeof fields.personTitle === 'string' && fields.personTitle) || contact?.title || null,
            personEmail: (typeof fields.personEmail === 'string' && fields.personEmail) || contact?.email || null,
            companyEmail: (typeof fields.companyEmail === 'string' && fields.companyEmail) || emails[0] || null,
            decisionMakerLinkedIn: mergedProfiles.find((profile) => profile.role === 'decision_maker' && profile.platform === 'linkedin')?.profileUrl ?? null,
            companyFacebook: mergedProfiles.find((profile) => profile.role === 'company' && profile.platform === 'facebook')?.profileUrl ?? null,
            companyInstagram: mergedProfiles.find((profile) => profile.role === 'company' && profile.platform === 'instagram')?.profileUrl ?? null,
          },
          ...(mergedContacts.length ? { openRouterContacts: mergedContacts } : {}),
          ...(mergedProfiles.length ? { openRouterSocialProfiles: mergedProfiles } : {}),
        };
      } catch (error) {
        this.logger.warn(JSON.stringify({
          event: 'discovery.search.contact_social_enrichment_failed',
          provider: this.name,
          executionId: context.searchExecutionId,
          companyName: candidate.name,
          error: error instanceof Error ? error.message : 'unknown error',
        }));
      }
    }
  }

  normalizeResult(raw: unknown): NormalizedSourceResult {
    if (!isNormalizedSourceResult(raw)) {
      throw new SourceProviderError('PROVIDER_INVALID_RESPONSE', 'OpenRouter returned a malformed discovery result.');
    }
    return raw;
  }

  private async searchText(
    query: string,
    plan: SearchPlan,
    maxResults: number,
    requestedCount: number,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<WebSearchResult[]> {
    try {
      return await this.requestSearchText(query, plan, maxResults, requestedCount, deadline, signal);
    } catch (error) {
      const category = error instanceof SourceProviderError ? error.code : 'PROVIDER_UNAVAILABLE';
      this.logFailure(category, undefined, error);
      if (error instanceof SourceProviderError) throw error;
      throw new SourceProviderError('PROVIDER_UNAVAILABLE', 'OpenRouter discovery request failed.');
    }
  }

  private async requestSearchText(
    query: string,
    plan: SearchPlan,
    maxResults: number,
    requestedCount: number,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<WebSearchResult[]> {
    const endpoint = `${this.baseUrl}/chat/completions`;
    const request: RequestInit = {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          plugins: [{ id: 'web', max_results: maxResults }],
          max_tokens: 4000,
          temperature: 0,
          messages: [
            {
              role: 'system',
              content: [
                'Search the public web for real companies matching the search plan.',
                'Return concise, readable Markdown bullets or short paragraphs, not JSON.',
                `For EACH discovered ${isTexasStatePlan(plan) ? 'Texas real estate' : 'matching real estate'} company, actively research and output its company name, official website URL, Founder / Owner / CEO full name, title, and publicly available email or contact email.`,
                'For every company, actively look up public contact emails, LinkedIn profile URLs, Facebook page URLs, and Instagram handles. Return "Not Found" only after searching public sources.',
                'If a specific decision-maker email is unavailable, extract any business email or contact email found on the page or citation. If no person or email is publicly available, leave that field out rather than guessing.',
                'Use only details supported by the web results and citations. Do not guess missing details, contact details, or email addresses.',
                'Follow the requested locations, categories, and exclusions. Do not include adjacent business types unless they also clearly qualify.',
                'Use one compact bullet per company and include only publicly supported field values to fit as many distinct companies as possible.',
              ].join(' '),
            },
            {
              role: 'user',
              content: [
                `Search query: ${query}`,
                ...(isTexasStatePlan(plan) && requestedCount >= CANDIDATES_PER_LARGE_CHUNK
                  ? [`Regional sub-query: ${query}`]
                  : []),
                `Return up to ${Math.min(requestedCount, requestedCount >= CANDIDATES_PER_LARGE_CHUNK ? CANDIDATES_PER_LARGE_CHUNK : CANDIDATES_PER_CHUNK)} distinct matching companies for this discovery batch.`,
                ...(isTexasStatePlan(plan) && requestedCount >= CANDIDATES_PER_LARGE_CHUNK
                  ? ['Research this Texas city/region sub-query thoroughly and continue until at least 15 distinct qualifying companies are found when available.']
                  : []),
                `Search intent: ${plan.searchIntent || plan.originalPrompt || query}`,
                `Locations from SearchPlan: ${plan.locations.map(formatLocation).join('; ') || 'not specified'}`,
                `Allowed lead categories from SearchPlan: ${plan.leadTypes.join(', ') || plan.industry.join(', ') || plan.category || 'not specified'}`,
                `Requested contact roles: ${(plan.decisionMakerRoles ?? plan.requiredRoles ?? plan.contactRequirements?.titles ?? []).join(', ') || 'publicly cited company decision makers'}`,
                `Requested person/contact fields: ${(plan.personFields ?? plan.contactRequirements?.fields ?? []).join(', ') || 'name, title, and publicly cited email when available'}`,
                `Explicit exclusions: ${(plan.exclusions ?? []).join(', ') || 'none'}`,
                `Return no more than ${requestedCount >= CANDIDATES_PER_LARGE_CHUNK ? CANDIDATES_PER_LARGE_CHUNK : CANDIDATES_PER_CHUNK} companies for this sub-query. If no companies match, say so briefly.`,
              ].join('\n'),
            },
          ],
        }),
        ...(signal ? { signal } : {}),
      };
    let response: Response | undefined;
      let transientAttempt = 0;
      for (;;) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          this.logFailure('PROVIDER_TIMEOUT');
          throw new SourceProviderError('PROVIDER_TIMEOUT', 'OpenRouter discovery exceeded its 30-second execution limit.');
        }
        try {
          response = await this.outbound.fetch(endpoint, request, Math.min(this.timeoutMs, remainingMs), 0);
        } catch (error) {
          const timedOut = error instanceof OutboundRequestError && /timed out/i.test(error.message);
        if (timedOut) {
          this.logFailure('PROVIDER_TIMEOUT');
          throw new SourceProviderError('PROVIDER_TIMEOUT', 'OpenRouter discovery request timed out.');
        }
        if (transientAttempt < this.retries && !signal?.aborted) {
          await this.waitBeforeRetry(transientAttempt++, deadline);
          continue;
        }
        this.logFailure('PROVIDER_UNAVAILABLE');
        throw new SourceProviderError('PROVIDER_UNAVAILABLE', 'OpenRouter discovery is temporarily unavailable.');
      }
      if ((response.status === 429 || response.status >= 500)
        && transientAttempt < MAX_TRANSIENT_RETRIES
        && !signal?.aborted) {
        await this.waitBeforeRetry(transientAttempt++, deadline);
        continue;
      }
      break;
    }
    if (!response
      || !Number.isInteger(response.status)
      || response.status < 100
      || response.status > 599
      || typeof response.json !== 'function') {
      this.logFailure('PROVIDER_INVALID_RESPONSE');
      throw new SourceProviderError('PROVIDER_INVALID_RESPONSE', 'OpenRouter returned a malformed HTTP response.');
    }

    if (response.status === 401 || response.status === 403) {
      this.logFailure('PROVIDER_AUTH_ERROR', response.status);
      throw new SourceProviderError('PROVIDER_AUTH_ERROR', 'OpenRouter authentication failed.');
    }
    if (response.status === 402) {
      this.logFailure('PROVIDER_QUOTA_EXCEEDED', response.status);
      throw new SourceProviderError('PROVIDER_QUOTA_EXCEEDED', 'OpenRouter credit or quota limit was reached.');
    }
    if (response.status === 429) {
      this.logFailure('PROVIDER_RATE_LIMITED', response.status);
      throw new SourceProviderError('PROVIDER_RATE_LIMITED', 'OpenRouter rate limit was reached.');
    }
    if (response.status >= 500) {
      this.logFailure('PROVIDER_UNAVAILABLE', response.status);
      throw new SourceProviderError('PROVIDER_UNAVAILABLE', `OpenRouter returned HTTP ${response.status}.`);
    }
    if (response.status < 200 || response.status >= 300) {
      this.logFailure('PROVIDER_INVALID_REQUEST', response.status);
      throw new SourceProviderError('PROVIDER_INVALID_REQUEST', `OpenRouter rejected the discovery request with HTTP ${response.status}.`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      this.logFailure('PROVIDER_INVALID_RESPONSE', response.status, error);
      throw new SourceProviderError('PROVIDER_INVALID_RESPONSE', 'OpenRouter returned invalid JSON.');
    }
    const serializedResponse = safeSerialize(payload);
    this.logger.debug(JSON.stringify({
      event: 'discovery.search.raw_response',
      provider: this.name,
      status: response.status,
      response: serializedResponse.slice(0, MAX_DEBUG_RESPONSE_CHARS),
      truncated: serializedResponse.length > MAX_DEBUG_RESPONSE_CHARS,
    }));
    try {
      return parseSearchResponse(payload, this.name);
    } catch (error) {
      const category = error instanceof SourceProviderError ? error.code : 'PROVIDER_INVALID_RESPONSE';
      this.logFailure(category, response.status, error);
      if (error instanceof SourceProviderError) throw error;
      throw new SourceProviderError('PROVIDER_INVALID_RESPONSE', 'OpenRouter returned an unexpected discovery response.');
    }
  }

  private logFailure(category: string, status?: number, error?: unknown) {
    this.logger.warn(JSON.stringify({
      event: 'discovery.search.failed',
      provider: this.name,
      category,
      ...(status ? { status } : {}),
      ...(error instanceof Error ? { errorType: error.name, stack: error.stack } : {}),
    }));
  }

  private async waitBeforeRetry(retryIndex: number, deadline: number): Promise<void> {
    const delayMs = 2000 * (2 ** retryIndex);
    if (Date.now() + delayMs >= deadline) {
      this.logFailure('PROVIDER_TIMEOUT');
      throw new SourceProviderError('PROVIDER_TIMEOUT', 'OpenRouter retry delay exceeded the request time limit.');
    }
    await this.sleep(delayMs);
  }

  private sleep(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
}

function mergeCollections(
  chunks: WebCompanyCollection[],
  results: NormalizedSourceResult[],
  providerError: string | null,
): WebCompanyCollection {
  const snapshots = chunks.flatMap((chunk) => chunk.yieldSnapshot ? [chunk.yieldSnapshot] : []);
  const families = new Map<string, DiscoveryYieldSnapshot['families'][number]>();
  const rejectionCounts: DiscoveryYieldSnapshot['rejectionCounts'] = {};
  const locationYield = new Map<string, DiscoveryYieldSnapshot['locationYield'][number]>();
  const categoryYield = new Map<string, DiscoveryYieldSnapshot['categoryYield'][number]>();

  for (const snapshot of snapshots) {
    for (const family of snapshot.families) {
      const key = `${family.familyId}|${family.categoryPhrase}|${family.locationVariant}`;
      const existing = families.get(key);
      if (!existing) {
        families.set(key, { ...family, rejectionReasons: { ...family.rejectionReasons } });
        continue;
      }
      for (const field of ['queriesIssued', 'queriesSkipped', 'rawHits', 'usableCandidates', 'newlyAccepted', 'duplicates', 'rejected'] as const) {
        existing[field] += family[field];
      }
      for (const [reason, count] of Object.entries(family.rejectionReasons)) {
        existing.rejectionReasons[reason as keyof typeof existing.rejectionReasons] =
          (existing.rejectionReasons[reason as keyof typeof existing.rejectionReasons] ?? 0) + (count ?? 0);
      }
      existing.consecutiveZeroNew = family.consecutiveZeroNew;
      existing.required ||= family.required;
    }
    for (const [reason, count] of Object.entries(snapshot.rejectionCounts)) {
      rejectionCounts[reason as keyof typeof rejectionCounts] =
        (rejectionCounts[reason as keyof typeof rejectionCounts] ?? 0) + (count ?? 0);
    }
    mergeYieldRows(locationYield, snapshot.locationYield, (row) => row.locationVariant);
    mergeYieldRows(categoryYield, snapshot.categoryYield, (row) => row.categoryPhrase);
  }

  const queriesRun = chunks.reduce((sum, chunk) => sum + chunk.queriesRun, 0);
  const newlyAccepted = snapshots.reduce((sum, snapshot) => sum + snapshot.newlyAccepted, 0);
  const duplicates = snapshots.reduce((sum, snapshot) => sum + snapshot.duplicates, 0);
  const rejected = chunks.reduce((sum, chunk) => sum + chunk.rejected, 0);
  const latestSnapshot = snapshots[snapshots.length - 1];
  const yieldSnapshot = latestSnapshot ? {
    families: [...families.values()],
    rejectionCounts,
    locationYield: [...locationYield.values()],
    categoryYield: [...categoryYield.values()],
    queriesIssued: snapshots.reduce((sum, snapshot) => sum + snapshot.queriesIssued, 0),
    queriesSkippedLowYield: snapshots.reduce((sum, snapshot) => sum + snapshot.queriesSkippedLowYield, 0),
    newlyAccepted,
    duplicates,
    rejected: snapshots.reduce((sum, snapshot) => sum + snapshot.rejected, 0),
    acceptanceRate: queriesRun > 0 ? Number((newlyAccepted / queriesRun).toFixed(4)) : 0,
    yieldPerQuery: queriesRun > 0 ? Number((newlyAccepted / queriesRun).toFixed(4)) : 0,
    stopReason: chunks[chunks.length - 1]?.stopReason ?? latestSnapshot.stopReason,
    rejectionSummary: uniqueText(chunks.map((chunk) => chunk.rejectionSummary)),
    locationYieldSummary: uniqueText(chunks.map((chunk) => chunk.locationYieldSummary)),
    categoryYieldSummary: uniqueText(chunks.map((chunk) => chunk.categoryYieldSummary)),
  } satisfies DiscoveryYieldSnapshot : undefined;

  return {
    results,
    rejected,
    providerError,
    queriesRun,
    queriesSkippedDuplicate: chunks.reduce((sum, chunk) => sum + (chunk.queriesSkippedDuplicate ?? 0), 0),
    queriesSkippedBudget: chunks.reduce((sum, chunk) => sum + (chunk.queriesSkippedBudget ?? 0), 0),
    queriesSkippedLowYield: chunks.reduce((sum, chunk) => sum + (chunk.queriesSkippedLowYield ?? 0), 0),
    queryFamiliesGenerated: chunks.reduce((sum, chunk) => sum + (chunk.queryFamiliesGenerated ?? 0), 0),
    queriesGenerated: chunks.reduce((sum, chunk) => sum + (chunk.queriesGenerated ?? 0), 0),
    rejectionCounts,
    rejectionSummary: uniqueText(chunks.map((chunk) => chunk.rejectionSummary)),
    locationYieldSummary: uniqueText(chunks.map((chunk) => chunk.locationYieldSummary)),
    categoryYieldSummary: uniqueText(chunks.map((chunk) => chunk.categoryYieldSummary)),
    yieldPerQuery: yieldSnapshot?.yieldPerQuery ?? 0,
    stopReason: yieldSnapshot?.stopReason ?? null,
    ...(yieldSnapshot ? { yieldSnapshot } : {}),
  };
}

function mergeYieldRows<T extends { newlyAccepted: number; rawHits: number; duplicates: number; rejected: number }>(
  target: Map<string, T>,
  rows: T[],
  keyOf: (row: T) => string,
) {
  for (const row of rows) {
    const key = keyOf(row);
    const existing = target.get(key);
    if (!existing) {
      target.set(key, { ...row });
      continue;
    }
    existing.newlyAccepted += row.newlyAccepted;
    existing.rawHits += row.rawHits;
    existing.duplicates += row.duplicates;
    existing.rejected += row.rejected;
  }
}

function uniqueText(values: Array<string | undefined>): string {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))].join(' | ');
}

function parseSearchResponse(payload: unknown, provider: string): WebSearchResult[] {
  const message = firstAssistantMessage(payload);
  if (!message || typeof message.content !== 'string') {
    throw new SourceProviderError('PROVIDER_INVALID_RESPONSE', 'OpenRouter returned a malformed discovery response.');
  }

  const annotations = Array.isArray(message.annotations) ? message.annotations : [];
  const citations = annotations.map(parseCitation).filter((citation): citation is Citation => citation !== null);
  const parsed = parseCandidateContent(message.content, citations);
  if (!parsed || typeof parsed !== 'object' || !('companies' in parsed) || !Array.isArray(parsed.companies)) {
    throw new SourceProviderError('PROVIDER_INVALID_RESPONSE', 'OpenRouter returned malformed company data.');
  }

  const retrievedAt = new Date().toISOString();
  const results: WebSearchResult[] = [];
  for (const rawItem of parsed.companies) {
    const normalized = normalizeCompanyRecord(rawItem);
    const candidateUrls = isRecord(normalized)
      ? [normalized.official_website, normalized.evidence_url, normalized.source_url, normalized.url]
        .filter((value): value is string => typeof value === 'string' && isHttpUrl(value))
      : [];
    const citationForUrl = citations.find((citation) => candidateUrls.some((url) => sameHost(url, citation.url)));
    const nameFromUrl = candidateUrls[0] ? companyNameFromUrl(candidateUrls[0]) : undefined;
    const explicitName = isRecord(normalized) && typeof normalized.company_name === 'string'
      ? normalized.company_name.trim()
      : '';
    const nameFromCitation = citationForUrl
      ? cleanCompanyName(citationForUrl.title.split(/\s+(?:\||—|–)\s+|\s+-\s+/)[0]!.trim()) ?? undefined
      : undefined;
    const candidateName = explicitName || nameFromCitation || nameFromUrl || '';
    const matchingCitations = citations.filter((citation) => candidateName
      && containsCompanyName(`${citation.title} ${citation.content}`, candidateName));
    const matchingCitation = matchingCitations.find((citation) => /official|website|homepage|home page/i.test(citation.title))
      ?? citationForUrl
      ?? matchingCitations[0]
      ?? (parsed.companies.length === 1 && citations.length === 1 ? citations[0] : undefined);
    const evidenceCitation = matchingCitations.find((citation) => new URL(citation.url).pathname !== '/')
      ?? matchingCitation;
    const websiteFallback = matchingCitation?.url ?? candidateUrls[0];
    const evidenceFallback = evidenceCitation?.url ?? websiteFallback;
    const item = isRecord(normalized)
      ? normalizeCompanyRecord({
          ...normalized,
          company_name: normalized.company_name ?? nameFromCitation ?? nameFromUrl,
          official_website: normalized.official_website ?? websiteFallback,
          evidence_url: evidenceFallback,
        })
      : normalized;
    if (!isCompanyRecord(item)) {
      continue;
    }
    const evidence = item.evidence_url
      ? citations.find((citation) => sameUrl(citation.url, item.evidence_url!))
      : undefined;
    const official = citations.find((citation) => sameHost(citation.url, item.official_website))
      ?? citations.find((citation) => item.evidence_url && sameHost(citation.url, item.evidence_url))
      ?? null;
    const sourceUrl = evidence?.url ?? official?.url ?? item.evidence_url ?? item.official_website;
    const sourceText = [
      evidence?.title,
      evidence?.content,
      official?.title,
      official?.content,
      item.description,
      item.activity,
      item.category,
      item.location,
      item.snippet,
    ].filter((part): part is string => typeof part === 'string' && Boolean(part.trim())).join(' ').trim();
    const extractedContacts = parseContacts(item.contacts, citations, retrievedAt, item.company_name, sourceUrl);
    const companyContext = [
      message.content.split(/\n\s*\n/).filter((part) => containsCompanyName(part, item.company_name)).join('\n'),
      ...matchingCitations.map((citation) => `${citation.title} ${citation.content} ${citation.url}`),
      sourceText,
    ].join('\n');
    const socialProfiles = extractSocialProfiles(normalized, companyContext);
    const explicitEmail = isRecord(normalized)
      ? [normalized.company_email, normalized.companyEmail, normalized.email, normalized.contact_email]
        .find((value): value is string => typeof value === 'string' && isEmailAddress(value))
      : undefined;
    EMAIL_PATTERN.lastIndex = 0;
    const companyEmail = (explicitEmail ?? companyContext.match(EMAIL_PATTERN)?.[0])?.toLowerCase();
    EMAIL_PATTERN.lastIndex = 0;
    const citationStatus: WebSearchResult['citationStatus'] = evidence || official
      ? 'CITATION_PRESENT'
      : 'CITATION_ANNOTATION_MISSING';
    results.push({
      title: item.company_name.trim(),
      url: sourceUrl,
      website: official?.url ?? item.official_website,
      ...(extractedContacts.length ? { extractedContacts } : {}),
      ...(companyEmail ? { companyEmail } : {}),
      ...(socialProfiles.length ? { socialProfiles } : {}),
      snippet: sourceText.slice(0, 2000) || item.company_name,
      source: provider,
      retrievedAt,
      citationStatus,
    });
  }
  if (parsed.companies.length > 0 && results.length === 0) {
    throw new SourceProviderError('PROVIDER_INVALID_RESPONSE', 'OpenRouter returned a malformed company record.');
  }
  return results;
}

function parseCandidateContent(content: string, citations: Citation[] = []): { companies: unknown[] } | null {
  const cleaned = content.replace(/^\uFEFF/, '').trim();
  const withoutFence = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const candidatesToParse = [cleaned, withoutFence, ...extractJsonValues(cleaned)];
  for (const candidate of candidatesToParse) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      const companies = candidateArray(parsed);
      if (companies) return { companies };
    } catch {
      // Try the next embedded JSON value or the plain-text fallback.
    }
  }
  const completeCompanies = extractCompleteCompanyRecords(cleaned);
  if (completeCompanies.length > 0) return { companies: completeCompanies };
  if (/^(?:\{|\[)/.test(cleaned)) return null;
  const companies = parseBulletCandidates(cleaned);
  if (companies.length) return { companies };
  const freeTextCompanies = parseFreeTextCandidates(cleaned, citations);
  return freeTextCompanies.length ? { companies: freeTextCompanies } : null;
}

function parseFreeTextCandidates(content: string, citations: Citation[]): unknown[] {
  const markdownLinks = [...content.matchAll(/\[([^\]]{2,160})\]\((https?:\/\/[^)\s]+)\)/gi)]
    .map((match) => ({ label: match[1]!.trim(), url: trimUrl(match[2]!) }));
  const paragraphs = content.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
  const sources = citations.map((citation) => ({
    title: citation.title,
    text: `${citation.title} ${citation.content}`.trim(),
    url: citation.url,
  }));
  const names = new Map<string, string>();
  const addName = (value: string) => {
    const name = cleanCompanyName(value);
    if (name) names.set(name.toLowerCase(), name);
  };

  for (const { label } of markdownLinks) addName(label);
  for (const match of content.matchAll(/(?:^|\n)\s*(?:[-*]\s*)?(?:company(?:\s+name)?|business)\s*:\s*([^\n|;]+)/gi)) {
    addName(match[1]!);
  }
  for (const match of content.matchAll(/\b(?:owner|founder|CEO|president|principal|managing partner)\s+of\s+(?:the\s+)?(?:\*\*)?([A-Z][A-Za-z0-9&'’., -]{2,100}?)(?:\*\*)?(?=\s+(?:is|was|at|based|in|,|\.|;|$))/g)) {
    addName(match[1]!);
  }
  for (const match of content.matchAll(/\*\*([^*\n]{3,120})\*\*/g)) addName(match[1]!);
  for (const source of sources) {
    const title = source.title
      .split(/\s+(?:\||—|–)\s+|\s+-\s+(?=(?:official|home|about|contact|website)\b)/i)[0]!
      .replace(/\s+(?:in|serving)\s+(?:Texas|Florida|California|New York|the United States)\s*$/i, '')
      .trim();
    addName(title);
  }

  const results: unknown[] = [];
  for (const name of names.values()) {
    const matchingParagraphs = paragraphs.filter((part) => containsCompanyName(part, name));
    const matchingSources = sources.filter((source) => containsCompanyName(source.text, name));
    const matchingLinks = markdownLinks.filter((link) => containsCompanyName(link.label, name));
    const context = [
      ...matchingParagraphs,
      ...matchingSources.map((source) => source.text),
    ].join('\n');
    const urls = [...new Set([
      ...matchingLinks.map((link) => link.url),
      ...extractHttpUrls(context),
      ...matchingSources.map((source) => source.url),
    ])];
    if (!urls.length) continue;
    const officialLink = matchingLinks.find((link) => /official|website|homepage|home page/i.test(link.label));
    const officialCitation = matchingSources.find((source) => /official|website|homepage|home page/i.test(source.title));
    const website = officialLink?.url ?? officialCitation?.url ?? urls[0]!;
    const evidenceUrl = matchingSources.find((source) => !sameHost(source.url, website))?.url
      ?? matchingSources.find((source) => new URL(source.url).pathname !== '/')?.url
      ?? matchingSources[0]?.url
      ?? website;
    const contact = extractFreeTextContact(context, name, evidenceUrl);
    results.push({
      company_name: name,
      official_website: website,
      evidence_url: evidenceUrl,
      activity: context.slice(0, 2000),
      contacts: contact ? [contact] : [],
    });
  }
  return results;
}

function extractFreeTextContact(text: string, companyName: string, evidenceUrl: string): ContactRecord | null {
  const roles = 'Owner|Founder|Co-Founder|CEO|President|Principal|Managing Partner|Director|Chief Executive Officer';
  const namedRole = text.match(new RegExp(`\\b([A-Z][a-z’'-]+(?:\\s+[A-Z][a-z’'-]+){1,3})\\s*(?:,|is|serves as)?\\s+(?:the\\s+)?(${roles})\\b`));
  const roleNamed = text.match(new RegExp(`\\b(?:${roles})\\s*(?:of\\s+${escapeRegex(companyName)}\\s*)?(?:is|:|,)?\\s+([A-Z][A-Za-z’'-]+(?:\\s+[A-Z][A-Za-z’'-]+){1,3})\\b`, 'i'));
  const person = namedRole?.[1] ?? roleNamed?.[1];
  const title = namedRole?.[2] ?? (roleNamed ? roleNamed[0].match(new RegExp(roles, 'i'))?.[0] : undefined);
  const email = text.match(EMAIL_PATTERN)?.[0];
  if (!person || !title) return null;
  return {
    full_name: person.trim(),
    title: title.trim(),
    ...(email ? { email: email.toLowerCase() } : {}),
    evidence_url: evidenceUrl,
  };
}

function extractHttpUrls(text: string): string[] {
  return [...text.matchAll(/https?:\/\/[^\s<>)\]},"']+/gi)].map((match) => trimUrl(match[0]));
}

function trimUrl(value: string): string {
  return value.replace(/[.,;:!?]+$/, '');
}

function companyNameFromUrl(value: string): string | undefined {
  try {
    const hostname = new URL(value).hostname.replace(/^www\./i, '');
    const label = hostname.split('.')[0]?.replace(/[-_]+/g, ' ').trim();
    return label ? label.replace(/\b\w/g, (letter) => letter.toUpperCase()) : undefined;
  } catch {
    return undefined;
  }
}

function cleanCompanyName(value: string): string | null {
  const cleaned = value
    .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '')
    .replace(/^\[|\]$/g, '')
    .replace(/^\*\*|\*\*$/g, '')
    .replace(/\s+(?:-\s*)?(?:official website|official site|home page|homepage|website|about us|contact us)\s*$/i, '')
    .replace(/[|–—-]\s*$/, '')
    .trim();
  if (
    cleaned.length < 3
    || cleaned.length > 120
    || /^(?:official website|website|home|homepage|about|contact|read more|learn more|source)$/i.test(cleaned)
    || /^https?:\/\//i.test(cleaned)
  ) return null;
  return cleaned;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractCompleteCompanyRecords(text: string): unknown[] {
  const companies: unknown[] = [];
  const companyNameFields = [...text.matchAll(/"company_name"\s*:/g)].map((match) => match.index ?? -1);
  if (companyNameFields.length === 0) return companies;
  const objects: Array<{ start: number; hasCompanyName: boolean }> = [];
  let nextCompanyNameField = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      while (companyNameFields[nextCompanyNameField] === index) {
        const current = objects[objects.length - 1];
        if (current) current.hasCompanyName = true;
        nextCompanyNameField += 1;
      }
      quoted = true;
      continue;
    }
    if (char === '{') {
      objects.push({ start: index, hasCompanyName: false });
      continue;
    }
    if (char !== '}' || objects.length === 0) continue;
    const candidate = objects.pop();
    if (!candidate) continue;

    if (candidate.hasCompanyName) {
      try {
        const parsed: unknown = JSON.parse(text.slice(candidate.start, index + 1));
        const normalized = normalizeCompanyRecord(parsed);
        if (isCompanyRecord(normalized)) companies.push(normalized);
      } catch {
        // Ignore incomplete or malformed records and retain completed company objects.
      }
    }
    const parent = objects[objects.length - 1];
    if (candidate.hasCompanyName && parent) parent.hasCompanyName = true;
  }
  return companies;
}

function candidateArray(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return null;
  for (const key of ['companies', 'candidates', 'results'] as const) {
    if (Array.isArray(value[key])) return value[key] as unknown[];
  }
  if ('company_name' in value || 'companyName' in value || 'name' in value) return [value];
  return null;
}

function extractJsonValues(text: string): string[] {
  const values: string[] = [];
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === '{' || char === '[') {
      if (depth === 0) start = index;
      depth += 1;
    } else if ((char === '}' || char === ']') && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        values.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return values;
}

function normalizeCompanyRecord(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const website = value.official_website ?? value.officialWebsite ?? value.website;
  return {
    ...value,
    company_name: value.company_name ?? value.companyName ?? value.name,
    official_website: website,
    email: value.company_email ?? value.companyEmail ?? value.email ?? value.contact_email,
    evidence_url: value.evidence_url ?? value.evidenceUrl ?? value.source_url ?? value.sourceUrl ?? value.evidence ?? website,
    contacts: value.contacts ?? value.people ?? [],
  };
}

function parseBulletCandidates(text: string): unknown[] {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const records: Array<{ name?: string; urls: string[]; contacts: Record<string, string>[] }> = [];
  let current: typeof records[number] | undefined;
  const startRecord = (name: string) => {
    current = { name, urls: [], contacts: [] };
    records.push(current);
  };
  for (const rawLine of lines) {
    const line = rawLine.replace(/^(?:[-*•]|\d+[.)])\s*/, '').trim();
    const nameMatch = line.match(/^(?:company(?:\s+name)?|name)\s*:\s*(.+)$/i);
    if (nameMatch) {
      startRecord(nameMatch[1]!.split(/\s+\|\s+/)[0]!.trim());
    } else if (!current
      && /^(?:[-*•]|\d+[.)])\s+/.test(rawLine)
      && !/^(?:official website|website|evidence(?: url)?|source(?: url)?|person(?: name)?|contact|full[_ ]?name|title|email|person title|person email)\s*:/i.test(line)) {
      const leadingName = line.split(/\s+\|\s+/)[0]!.trim();
    if (leadingName) {
      startRecord(leadingName);
    }
    }
    if (!current) continue;
    const urls = line.match(/https?:\/\/[^\s<>)\]},"']+/gi) ?? [];
    for (const url of urls) if (!current.urls.includes(url.replace(/[.;]$/, ''))) current.urls.push(url.replace(/[.;]$/, ''));
    const contact = current.contacts[0] ?? {};
    const fullName = line.match(/^(?:person(?:\s+name)?|contact|full[_ ]?name)\s*:\s*(.+)$/i);
    const title = line.match(/^(?:title|person title)\s*:\s*(.+)$/i);
    const email = line.match(/^(?:email|person email)\s*:\s*([^\s,;]+)/i);
    if (fullName) contact.full_name = fullName[1]!.trim();
    if (title) contact.title = title[1]!.trim();
    if (email) contact.email = email[1]!.trim();
    if (Object.keys(contact).length) current.contacts[0] = contact;
  }
  return records.flatMap(({ name, urls, contacts }) => name && urls.length
    ? [{
        company_name: name,
        official_website: urls[0],
        evidence_url: urls[1] ?? urls[0],
        contacts: contacts.length ? contacts.map((contact) => ({
          ...contact,
          evidence_url: urls[1] ?? urls[0],
        })) : [],
      }]
    : []);
}

function safeSerialize(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable response]';
  }
}

function firstAssistantMessage(payload: unknown): { content?: unknown; annotations?: unknown[] } | null {
  if (!isRecord(payload)) return null;
  const choices = payload.choices;
  if (!Array.isArray(choices)) return null;
  const message = isRecord(choices[0]) && isRecord(choices[0].message)
    ? choices[0].message
    : null;
  if (!message || typeof message.content !== 'string') return null;
  return {
    content: message.content,
    annotations: Array.isArray(message.annotations) ? message.annotations : undefined,
  };
}

function parseCitation(value: unknown): Citation | null {
  if (!isRecord(value)) return null;
  const item = isRecord(value.url_citation) ? value.url_citation : null;
  if (!item) return null;
  if (typeof item.url !== 'string' || !isHttpUrl(item.url)) return null;
  return {
    url: item.url,
    title: typeof item.title === 'string' ? item.title : '',
    content: typeof item.content === 'string' ? item.content : '',
  };
}

function isCompanyRecord(value: unknown): value is CompanyRecord {
  if (!isRecord(value)) return false;
  const item = value as { company_name?: unknown; official_website?: unknown; evidence_url?: unknown; contacts?: unknown };
  return typeof item.company_name === 'string'
    && item.company_name.trim().length > 0
    && typeof item.official_website === 'string'
    && isHttpUrl(item.official_website)
    && typeof item.evidence_url === 'string'
    && isHttpUrl(item.evidence_url)
    && (item.contacts === undefined || Array.isArray(item.contacts));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseContacts(
  value: unknown,
  citations: Citation[],
  retrievedAt: string,
  companyName: string,
  fallbackSourceUrl: string,
): NonNullable<WebSearchResult['extractedContacts']> {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new SourceProviderError('PROVIDER_INVALID_RESPONSE', 'OpenRouter returned malformed contact data.');
  }
  const contacts: NonNullable<WebSearchResult['extractedContacts']> = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const contact = raw as Partial<ContactRecord>;
    if (
      typeof contact.full_name !== 'string'
      || !contact.full_name.trim()
      || typeof contact.title !== 'string'
      || !contact.title.trim()
      || (contact.evidence_url !== undefined
        && (typeof contact.evidence_url !== 'string' || !isHttpUrl(contact.evidence_url)))
    ) continue;
    if (contact.email !== undefined && typeof contact.email !== 'string') continue;
    const citedEvidence = typeof contact.evidence_url === 'string'
      ? citations.find((entry) => sameUrl(entry.url, contact.evidence_url!))
      : undefined;
    const citation = citedEvidence && contactEvidenceSupports(citedEvidence, companyName, contact)
      ? citedEvidence
      : citations.find((entry) => contactEvidenceSupports(entry, companyName, contact));
    const evidenceExcerpt = citation
      ? `${citation.title} ${citation.content}`.trim()
      : `${companyName}: ${contact.full_name.trim()}, ${contact.title.trim()}${contact.email?.trim() ? `, ${contact.email.trim()}` : ''}`;
    if (citation && (!containsCompanyName(evidenceExcerpt, contact.full_name) || !containsCompanyName(evidenceExcerpt, contact.title))) continue;
    const email = contact.email?.trim().toLowerCase();
    if (email && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !containsCompanyName(evidenceExcerpt, email))) continue;
    contacts.push({
      fullName: contact.full_name.trim(),
      title: contact.title.trim(),
      ...(email ? { email } : {}),
      ...socialUrlsForContact(contact).reduce((links, profile) => {
        if (profile.platform === 'linkedin' && profile.role === 'decision_maker') links.linkedinUrl = profile.profileUrl;
        if (profile.platform === 'facebook') links.facebookUrl = profile.profileUrl;
        if (profile.platform === 'instagram') links.instagramUrl = profile.profileUrl;
        return links;
      }, {} as Pick<NonNullable<WebSearchResult['extractedContacts']>[number], 'linkedinUrl' | 'facebookUrl' | 'instagramUrl'>),
      sourceUrl: citation?.url ?? fallbackSourceUrl,
      evidenceExcerpt: evidenceExcerpt.slice(0, 2000),
      retrievedAt,
    });
  }
  return contacts;
}

function contactEvidenceSupports(citation: Citation, companyName: string, contact: Partial<ContactRecord>): boolean {
  const evidence = `${citation.title} ${citation.content}`.trim();
  return containsCompanyName(evidence, companyName)
    && typeof contact.full_name === 'string'
    && containsCompanyName(evidence, contact.full_name)
    && typeof contact.title === 'string'
    && containsCompanyName(evidence, contact.title)
    && (!contact.email || containsCompanyName(evidence, contact.email));
}

function extractSocialProfiles(company: unknown, context: string): NonNullable<WebSearchResult['socialProfiles']> {
  const candidates = isRecord(company) ? [
    company.linkedin,
    company.linkedin_url,
    company.linkedinUrl,
    company.decisionMakerLinkedIn,
    company.decision_maker_linkedin,
    company.facebook,
    company.facebook_url,
    company.facebookUrl,
    company.companyFacebook,
    company.company_facebook,
    company.instagram,
    company.instagram_url,
    company.instagramUrl,
    company.companyInstagram,
    company.company_instagram,
  ] : [];
  const values = [
    ...candidates.flatMap((value) => typeof value === 'string' ? [value] : []),
    ...extractHttpUrls(context),
  ];
  const seen = new Set<string>();
  const result: NonNullable<WebSearchResult['socialProfiles']> = [];
  for (const value of values) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const segments = url.pathname.split('/').filter(Boolean);
    let platform: 'linkedin' | 'facebook' | 'instagram' | null = null;
    let role: 'company' | 'decision_maker' = 'company';
    if (host === 'linkedin.com') {
      platform = 'linkedin';
      if (segments[0]?.toLowerCase() === 'in') role = 'decision_maker';
      else if (segments[0]?.toLowerCase() !== 'company') continue;
    } else if (host === 'facebook.com' && segments.length > 0) platform = 'facebook';
    else if (host === 'instagram.com' && segments.length > 0) platform = 'instagram';
    if (!platform) continue;
    url.hash = '';
    url.search = '';
    const profileUrl = url.toString().replace(/\/$/, '');
    const key = `${platform}:${role}:${profileUrl.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ platform, profileUrl, role });
  }
  return result;
}

function socialUrlsForContact(contact: Partial<ContactRecord>): NonNullable<WebSearchResult['socialProfiles']> {
  return extractSocialProfiles({
    linkedin: contact.linkedin ?? contact.linkedin_url ?? contact.linkedinUrl,
    facebook: contact.facebook ?? contact.facebook_url ?? contact.facebookUrl,
    instagram: contact.instagram ?? contact.instagram_url ?? contact.instagramUrl,
  }, '');
}

function mergeSocialProfiles(
  current: unknown[],
  discovered: NonNullable<WebSearchResult['socialProfiles']>,
): NonNullable<WebSearchResult['socialProfiles']> {
  const profiles: NonNullable<WebSearchResult['socialProfiles']> = [];
  const seen = new Set<string>();
  for (const value of [...current, ...discovered]) {
    if (!isRecord(value)
      || !['linkedin', 'facebook', 'instagram'].includes(String(value.platform))
      || !['company', 'decision_maker'].includes(String(value.role))
      || typeof value.profileUrl !== 'string') continue;
    const profile = value as NonNullable<WebSearchResult['socialProfiles']>[number];
    const key = `${profile.platform}:${profile.role}:${profile.profileUrl.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    profiles.push(profile);
  }
  return profiles;
}

function mergeOpenRouterContacts(
  current: unknown[],
  discovered: NonNullable<WebSearchResult['extractedContacts']>,
): NonNullable<WebSearchResult['extractedContacts']> {
  const contacts: NonNullable<WebSearchResult['extractedContacts']> = [];
  const byIdentity = new Map<string, number>();
  for (const value of current) {
    if (!isRecord(value) || typeof value.fullName !== 'string' || typeof value.title !== 'string') continue;
    const contact = value as NonNullable<WebSearchResult['extractedContacts']>[number];
    byIdentity.set(`${contact.fullName.toLowerCase()}:${contact.title.toLowerCase()}`, contacts.length);
    contacts.push(contact);
  }
  for (const contact of discovered) {
    const key = `${contact.fullName.toLowerCase()}:${contact.title.toLowerCase()}`;
    const index = byIdentity.get(key);
    if (index === undefined) {
      byIdentity.set(key, contacts.length);
      contacts.push(contact);
      continue;
    }
    contacts[index] = { ...contacts[index]!, ...contact };
  }
  return contacts;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function isEmailAddress(value: string): boolean {
  return /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(value.trim());
}

function sameUrl(left: string, right: string): boolean {
  try {
    return canonicalUrl(left) === canonicalUrl(right);
  } catch {
    return false;
  }
}

function sameHost(left: string, right: string): boolean {
  try {
    return new URL(left).hostname.toLowerCase().replace(/^www\./, '')
      === new URL(right).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return false;
  }
}

function canonicalUrl(value: string): string {
  const url = new URL(value);
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function containsCompanyName(text: string, companyName: string): boolean {
  return text.toLowerCase().includes(companyName.trim().toLowerCase());
}

function formatLocation(location: SearchPlan['locations'][number]): string {
  return [location.city, location.state, location.region, location.postalCode, location.country]
    .filter((part): part is string => Boolean(part?.trim()))
    .join(', ');
}

function isTexasStatePlan(plan: SearchPlan): boolean {
  return plan.locations.some((location) => /^(?:TX|Texas)$/i.test(location.state?.trim() ?? ''));
}

function texasRegionalQuery(plan: SearchPlan, index: number): string {
  const city = TEXAS_DISCOVERY_CITIES[index % TEXAS_DISCOVERY_CITIES.length];
  const phrases = [
    'Cash home buyers',
    'Fix and flip real estate investors',
    'Real estate wholesalers',
    'We buy houses',
    'Wholesale property buyers',
    'Texas cash home buying companies',
    'Cash property investors',
    'Fix and flip investment companies',
    'Residential real estate investment buyers',
    'Local house-flipping and wholesale investors',
  ];
  const phrase = phrases[index % phrases.length];
  const modifier = ['contact email website owner', 'LinkedIn Facebook contact', 'founder email', 'contact details']
    [index % 4];
  const categories = plan.leadTypes.length
    ? ` Search only categories: ${plan.leadTypes.join(', ')}.`
    : '';
  return `${phrase} in ${city} TX ${modifier}.${categories}`;
}

function httpsBaseUrl(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return undefined;
    return url.toString().replace(/\/+$/, '');
  } catch {
    return undefined;
  }
}

function positiveInt(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value! > 0 ? value! : fallback;
}

function isNormalizedSourceResult(value: unknown): value is NormalizedSourceResult {
  return Boolean(
    value && typeof value === 'object'
    && 'externalId' in value && typeof value.externalId === 'string'
    && 'name' in value && typeof value.name === 'string'
    && 'sourceUrl' in value && typeof value.sourceUrl === 'string',
  );
}
