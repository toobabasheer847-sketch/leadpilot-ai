import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OutboundRequestError, OutboundRequestService } from '../../../common/outbound-request.service';
import { discoveryTarget } from '../../../search/search-plan.limits';
import type { SearchPlan } from '../../../search/types/search-plan.types';
import {
  collectWebCompanyCandidates,
  queryBudgetForPlan,
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
const CANDIDATES_PER_CHUNK = 20;

interface Citation {
  url: string;
  title: string;
  content: string;
}

interface CompanyRecord {
  company_name: string;
  official_website: string;
  evidence_url: string;
  contacts?: unknown[];
}

interface ContactRecord {
  full_name: string;
  title: string;
  email?: string;
  evidence_url: string;
}

@Injectable()
export class OpenRouterDiscoveryProvider implements SourceProvider {
  readonly name = 'openrouter';
  private readonly logger = new Logger(OpenRouterDiscoveryProvider.name);
  private readonly apiKey?: string;
  private readonly model: string;
  private readonly baseUrl?: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly outbound: OutboundRequestService,
    private readonly config: ConfigService,
  ) {
    this.apiKey = config.get<string>('openRouter.apiKey')?.trim() || undefined;
    this.model = config.get<string>('openRouter.model')?.trim() || DEFAULT_MODEL;
    this.baseUrl = httpsBaseUrl(config.get<string>('openRouter.baseUrl') || DEFAULT_BASE_URL);
    this.timeoutMs = positiveInt(config.get<number>('openRouter.timeoutMs'), 120000);
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

    const target = discoveryTarget(plan);
    const concurrency = positiveInt(
      this.config.get<number>('sourceProvider.discoveryQueryConcurrency')
        ?? this.config.get<number>('sourceProvider.concurrency'),
      1,
    );
    const queryTimeoutMs = Math.max(this.timeoutMs, positiveInt(
      this.config.get<number>('sourceProvider.discoveryQueryTimeoutMs')
        ?? this.config.get<number>('webSearch.timeoutMs'),
      this.timeoutMs,
    ));
    const maxResults = Math.min(MAX_RESULTS, positiveInt(this.config.get<number>('webSearch.maxResults'), 5));
    const chunkCount = Math.ceil(target / CANDIDATES_PER_CHUNK);
    const maxChunkAttempts = chunkCount + Math.max(
      1,
      this.config.get<number>('sourceProvider.discoveryMaxConsecutiveFailures') ?? 3,
    );
    const chunks: WebCompanyCollection[] = [];
    const results: NormalizedSourceResult[] = [];
    let chunkErrors: string[] = [];
    let lastChunkError: SourceProviderError | undefined;
    for (let chunkIndex = 0; chunkIndex < maxChunkAttempts && results.length < target; chunkIndex += 1) {
      const chunkTarget = Math.min(CANDIDATES_PER_CHUNK, target - results.length);
      let lastSearchError: SourceProviderError | undefined;
      const searchText: WebCompanySearchFn = (query, options) =>
        this.searchText(query, plan, maxResults, chunkTarget, options?.signal ?? context.signal).catch((error: unknown) => {
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
          }
          throw error;
        });
      const collection = await collectWebCompanyCandidates(plan, chunkTarget, searchText, {
        maxQueries: queryBudgetForPlan(plan, chunkTarget),
        concurrency,
        queryTimeoutMs,
        delayMs: Math.max(0, this.config.get<number>('sourceProvider.retryDelayMs') ?? 0),
        maxConsecutiveFailures: Math.max(1, this.config.get<number>('sourceProvider.discoveryMaxConsecutiveFailures') ?? 3),
        exclude: results,
        round: chunkIndex,
      });
      chunks.push(collection);
      results.push(...collection.results.slice(0, target - results.length));
      if (collection.providerError) {
        chunkErrors.push(collection.providerError);
        lastChunkError = lastSearchError;
        const timedOut = /timed out|timeout/i.test(collection.providerError)
          || lastSearchError?.code === 'PROVIDER_TIMEOUT';
        const malformed = lastSearchError?.code === 'PROVIDER_INVALID_RESPONSE';
        if (timedOut || malformed) {
          this.logger.warn(JSON.stringify({
            event: timedOut ? 'discovery.search.chunk_timed_out' : 'discovery.search.chunk_malformed',
            provider: this.name,
            executionId: context.searchExecutionId,
            chunk: chunkIndex + 1,
            candidatesRetained: results.length,
          }));
          continue;
        }
        if (results.length === 0 && lastSearchError) throw lastSearchError;
        break;
      }
    }
    const collection = mergeCollections(chunks, results, chunkErrors[0] ?? null);
    if (collection.providerError && collection.results.length === 0 && lastChunkError) {
      throw lastChunkError;
    }
    if (collection.providerError && collection.results.length === 0 && !/timed out|timeout/i.test(collection.providerError)) {
      throw new SourceProviderError(
        'PROVIDER_UNAVAILABLE',
        collection.providerError,
      );
    }
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

  normalizeResult(raw: unknown): NormalizedSourceResult {
    if (!isNormalizedSourceResult(raw)) {
      throw new SourceProviderError('PROVIDER_INVALID_RESPONSE', 'OpenRouter returned a malformed discovery result.');
    }
    return raw;
  }

  private async searchText(query: string, plan: SearchPlan, maxResults: number, requestedCount: number, signal?: AbortSignal): Promise<WebSearchResult[]> {
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
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content: [
                'Search the public web for real, currently operating companies that satisfy the supplied search plan.',
                'Return only JSON with a companies array. Never invent companies, websites, locations, evidence, or contact details.',
                'Only include companies whose name and eligible real-estate-investor activity are supported by returned web citations.',
                'Only use a cited official company website as official_website and a returned citation URL as evidence_url.',
                'For each matching company, extract publicly cited decision-maker names, titles, and emails when available. Include each field only when supported by a returned citation. Do not infer email patterns or generate or guess emails.',
                'Include contacts as an array of objects with full_name, title, optional email, and evidence_url; evidence_url must be a returned citation. Use an empty contacts array when no decision maker is cited.',
                'Do not include realtors, mortgage companies, property management, attorneys, photographers, software, or construction companies unless the cited evidence clearly shows that the company also operates as one of the requested real-estate investor categories.',
                'Each company must contain company_name, official_website, and evidence_url. Do not guess missing values.',
              ].join(' '),
            },
            {
              role: 'user',
              content: [
                `Search query: ${query}`,
                `Return up to ${requestedCount} distinct matching companies for this discovery batch.`,
                `Search intent: ${plan.searchIntent || plan.originalPrompt || query}`,
                `Locations from SearchPlan: ${plan.locations.map(formatLocation).join('; ') || 'not specified'}`,
                `Allowed lead categories from SearchPlan: ${plan.leadTypes.join(', ') || plan.industry.join(', ') || plan.category || 'not specified'}`,
                `Requested contact roles: ${(plan.decisionMakerRoles ?? plan.requiredRoles ?? plan.contactRequirements?.titles ?? []).join(', ') || 'publicly cited company decision makers'}`,
                `Requested person/contact fields: ${(plan.personFields ?? plan.contactRequirements?.fields ?? []).join(', ') || 'name, title, and publicly cited email when available'}`,
                `Explicit exclusions: ${(plan.exclusions ?? []).join(', ') || 'none'}`,
                'Return no company unless its activity and the location are supported by cited public-web evidence. Return {"companies":[]} when no companies match.',
              ].join('\n'),
            },
          ],
        }),
        ...(signal ? { signal } : {}),
      };
    let response: Response | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        response = await this.outbound.fetch(endpoint, request, this.timeoutMs, 0);
      } catch (error) {
        if (attempt === 0 && !signal?.aborted) continue;
        if (error instanceof OutboundRequestError && /timed out/i.test(error.message)) {
          this.logFailure('PROVIDER_TIMEOUT');
          throw new SourceProviderError('PROVIDER_TIMEOUT', 'OpenRouter discovery request timed out.');
        }
        this.logFailure('PROVIDER_UNAVAILABLE');
        throw new SourceProviderError('PROVIDER_UNAVAILABLE', 'OpenRouter discovery is temporarily unavailable.');
      }
      if (response.status < 500 || attempt === 1) break;
    }
    if (!response) {
      this.logFailure('PROVIDER_UNAVAILABLE');
      throw new SourceProviderError('PROVIDER_UNAVAILABLE', 'OpenRouter discovery is temporarily unavailable.');
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
    } catch {
      this.logFailure('PROVIDER_INVALID_RESPONSE', response.status);
      throw new SourceProviderError('PROVIDER_INVALID_RESPONSE', 'OpenRouter returned invalid JSON.');
    }
    try {
      return parseSearchResponse(payload, this.name);
    } catch (error) {
      this.logFailure(error instanceof SourceProviderError ? error.code : 'PROVIDER_INVALID_RESPONSE', response.status);
      throw error;
    }
  }

  private logFailure(category: string, status?: number) {
    this.logger.warn(JSON.stringify({
      event: 'discovery.search.failed',
      provider: this.name,
      category,
      ...(status ? { status } : {}),
    }));
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

  let parsed: unknown;
  try {
    parsed = JSON.parse(message.content);
  } catch {
    throw new SourceProviderError('PROVIDER_INVALID_RESPONSE', 'OpenRouter returned malformed company data.');
  }
  if (!parsed || typeof parsed !== 'object' || !('companies' in parsed) || !Array.isArray(parsed.companies)) {
    throw new SourceProviderError('PROVIDER_INVALID_RESPONSE', 'OpenRouter returned malformed company data.');
  }

  const annotations = Array.isArray(message.annotations) ? message.annotations : [];
  const citations = annotations.map(parseCitation).filter((citation): citation is Citation => citation !== null);
  const retrievedAt = new Date().toISOString();
  const results = [];
  for (const item of parsed.companies) {
    if (!isCompanyRecord(item)) {
      throw new SourceProviderError('PROVIDER_INVALID_RESPONSE', 'OpenRouter returned a malformed company record.');
    }
    const evidence = citations.find((citation) => sameUrl(citation.url, item.evidence_url));
    const official = citations.find((citation) => sameHost(citation.url, item.official_website));
    if (!evidence || !official) {
      throw new SourceProviderError('PROVIDER_INVALID_RESPONSE', 'OpenRouter returned company data without matching web citations.');
    }
    const sourceText = `${evidence.title} ${evidence.content} ${official.title} ${official.content}`.trim();
    if (!containsCompanyName(sourceText, item.company_name)) {
      throw new SourceProviderError('PROVIDER_INVALID_RESPONSE', 'OpenRouter returned a company name not supported by its citations.');
    }
    const extractedContacts = parseContacts(item.contacts, citations, retrievedAt);
    results.push({
      title: item.company_name.trim(),
      url: evidence.url,
      website: official.url,
      ...(extractedContacts.length ? { extractedContacts } : {}),
      snippet: sourceText.slice(0, 2000),
      source: provider,
      retrievedAt,
    });
  }
  return results;
}

function firstAssistantMessage(payload: unknown): { content?: unknown; annotations?: unknown[] } | null {
  if (!payload || typeof payload !== 'object' || !('choices' in payload) || !Array.isArray(payload.choices)) return null;
  const choice = payload.choices[0];
  if (!choice || typeof choice !== 'object' || !('message' in choice)) return null;
  const message = choice.message;
  if (!message || typeof message !== 'object') return null;
  return message as { content?: unknown; annotations?: unknown[] };
}

function parseCitation(value: unknown): Citation | null {
  if (!value || typeof value !== 'object' || !('url_citation' in value)) return null;
  const citation = value.url_citation;
  if (!citation || typeof citation !== 'object') return null;
  const item = citation as { url?: unknown; title?: unknown; content?: unknown };
  if (typeof item.url !== 'string' || !isHttpUrl(item.url)) return null;
  return {
    url: item.url,
    title: typeof item.title === 'string' ? item.title : '',
    content: typeof item.content === 'string' ? item.content : '',
  };
}

function isCompanyRecord(value: unknown): value is CompanyRecord {
  if (!value || typeof value !== 'object') return false;
  const item = value as { company_name?: unknown; official_website?: unknown; evidence_url?: unknown; contacts?: unknown };
  return typeof item.company_name === 'string'
    && item.company_name.trim().length > 0
    && typeof item.official_website === 'string'
    && isHttpUrl(item.official_website)
    && typeof item.evidence_url === 'string'
    && isHttpUrl(item.evidence_url)
    && (item.contacts === undefined || Array.isArray(item.contacts));
}

function parseContacts(value: unknown, citations: Citation[], retrievedAt: string): NonNullable<WebSearchResult['extractedContacts']> {
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
      || typeof contact.evidence_url !== 'string'
      || !isHttpUrl(contact.evidence_url)
    ) continue;
    if (contact.email !== undefined && typeof contact.email !== 'string') continue;
    const citation = citations.find((entry) => sameUrl(entry.url, contact.evidence_url as string));
    if (!citation) continue;
    const evidenceExcerpt = `${citation.title} ${citation.content}`.trim();
    if (!containsCompanyName(evidenceExcerpt, contact.full_name) || !containsCompanyName(evidenceExcerpt, contact.title)) continue;
    const email = contact.email?.trim().toLowerCase();
    if (email && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !containsCompanyName(evidenceExcerpt, email))) continue;
    contacts.push({
      fullName: contact.full_name.trim(),
      title: contact.title.trim(),
      ...(email ? { email } : {}),
      sourceUrl: citation.url,
      evidenceExcerpt: evidenceExcerpt.slice(0, 2000),
      retrievedAt,
    });
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
