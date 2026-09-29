import { createHash } from 'node:crypto';
import { discoveryQueryBudget, discoveryTarget } from '../../../search/search-plan.limits';
import { assessCategoryEvidence } from '../../../search/category-evidence';
import { assessPlanExclusions } from '../../../search/exclusion-evidence';
import { expansionCities, placeMentioned } from '../../../search/search-plan.places';
import { toCountryCode } from '../../location/location-evidence';
import type { SearchLocation, SearchPlan } from '../../../search/types/search-plan.types';
import { rejectDiscoveryUrl } from '../../services/discovery-candidate.gate';
import { discoveryIdentityKeys } from '../../services/discovery-fallback';
import {
  buildExpandedDiscoveryQueries,
  expandDiscoveryLocationVariants,
  expandDiscoveryPhrases,
  QueryFamilyYieldTracker,
  type DiscoveryQueryExpansionMetrics,
} from '../../services/discovery-query-expansion';
import type { NormalizedSourceResult } from '../../types/source.types';
import type { WebSearchResult } from '../../../enrichment/website/web-search.types';

const JOB_BOARDS = ['indeed.com', 'ziprecruiter.com', 'monster.com', 'simplyhired.com', 'careerbuilder.com'];
const LISTING = /\b(top\s+\d+|best\s+\d+|list of|companies to watch|ranking of|directory of|reviewed on|agencies? (?:in|for)|freelancers? (?:in|for))\b/i;
const CONTRADICTION = /\b(restaurant|dentist|church|school|hotel|cafe|bar & grill|auto repair|salon)\b/i;
const REAL_ESTATE_SIGNAL = /\b(real[\s-]?estate|realty|propert(?:y|ies)|acquisition|multifamily|apartment buildings?|wholesal(?:e|er|ing)|cash\s+home\s+buy|fix(?:\s|-)?and(?:\s|-)?flip)\b/i;
const INVESTOR_SIGNAL = /\b(real[\s-]?estate|realty|propert(?:y|ies)|investors?|investments?|acquisition|holdings|multifamily|wholesal(?:e|er|ing)|cash\s+home\s+buy|fix(?:\s|-)?and(?:\s|-)?flip|we\s+buy\s+houses?)\b/i;
const US_STATE_NAMES = [
  'Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado', 'Connecticut', 'Delaware', 'Florida', 'Georgia',
  'Hawaii', 'Idaho', 'Illinois', 'Indiana', 'Iowa', 'Kansas', 'Kentucky', 'Louisiana', 'Maine', 'Maryland',
  'Massachusetts', 'Michigan', 'Minnesota', 'Mississippi', 'Missouri', 'Montana', 'Nebraska', 'Nevada', 'New Hampshire',
  'New Jersey', 'New Mexico', 'New York', 'North Carolina', 'North Dakota', 'Ohio', 'Oklahoma', 'Oregon', 'Pennsylvania',
  'Rhode Island', 'South Carolina', 'South Dakota', 'Tennessee', 'Texas', 'Utah', 'Vermont', 'Virginia', 'Washington',
  'West Virginia', 'Wisconsin', 'Wyoming', 'District of Columbia',
];

export interface WebCompanyCollection {
  results: NormalizedSourceResult[];
  rejected: number;
  providerError: string | null;
  queriesRun: number;
  queriesSkippedDuplicate?: number;
  queriesSkippedBudget?: number;
  queriesSkippedLowYield?: number;
  queryFamiliesGenerated?: number;
  queriesGenerated?: number;
}

export type WebCompanySearchFn = (
  query: string,
  options?: { signal?: AbortSignal },
) => Promise<WebSearchResult[]>;

export interface CollectWebCompanyOptions {
  maxQueries?: number;
  delayMs?: number;
  concurrency?: number;
  queryTimeoutMs?: number;
  maxConsecutiveFailures?: number;
  persistChunkSize?: number;
  sleep?: (ms: number) => Promise<void>;
  exclude?: NormalizedSourceResult[];
  round?: number;
  /** Called as soon as a chunk of accepted candidates is ready — used for streaming persist. */
  onBatch?: (batch: NormalizedSourceResult[]) => Promise<void> | void;
}

export function companyDiscoveryQueries(plan: SearchPlan, maxQueries: number, round = 0): string[] {
  return buildExpandedDiscoveryQueries(plan, maxQueries, { round, includeTails: true }).variants.map((variant) => variant.query);
}

/** Plan-derived search phrases for investor / RE lead types (no hard-coded geography). */
export function investorDiscoveryPhrases(plan: SearchPlan): string[] {
  return expandDiscoveryPhrases(plan);
}

/** Places used for web company discovery (city expansion for state-only plans). */
export function discoverySearchPlaces(plan: SearchPlan): string[] {
  return expandDiscoveryLocationVariants(plan);
}

export function queryBudgetForPlan(plan: SearchPlan, remaining: number): number {
  // Use discoveryTarget so minimum intents get a slightly larger query budget.
  const requested = discoveryTarget(plan);
  return discoveryQueryBudget(Math.max(remaining, requested));
}

export function expandDiscoveryQueryPlan(plan: SearchPlan, maxQueries: number, round = 0) {
  return buildExpandedDiscoveryQueries(plan, maxQueries, { round, includeTails: true });
}

export async function collectWebCompanyCandidates(
  plan: SearchPlan,
  target: number,
  search: WebCompanySearchFn,
  options: CollectWebCompanyOptions = {},
): Promise<WebCompanyCollection> {
  const wanted = Math.max(0, Math.trunc(target));
  if (wanted === 0) {
    return emptyCollection();
  }
  const expansion = buildExpandedDiscoveryQueries(
    plan,
    options.maxQueries ?? queryBudgetForPlan(plan, wanted),
    { round: options.round ?? 0, includeTails: true },
  );
  const queries = expansion.variants;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const delayMs = Math.max(0, options.delayMs ?? 0);
  const concurrency = Math.max(1, Math.trunc(options.concurrency ?? 1));
  const queryTimeoutMs = options.queryTimeoutMs === undefined
    ? undefined
    : Math.max(1, Math.trunc(options.queryTimeoutMs));
  const maxConsecutiveFailures = options.maxConsecutiveFailures === undefined
    ? Number.POSITIVE_INFINITY
    : Math.max(1, Math.trunc(options.maxConsecutiveFailures));
  const persistChunkSize = Math.max(1, Math.trunc(options.persistChunkSize ?? wanted));
  const results: NormalizedSourceResult[] = [];
  const pendingChunk: NormalizedSourceResult[] = [];
  const seen = new Set<string>();
  for (const existing of options.exclude ?? []) discoveryIdentityKeys(existing).forEach((key) => seen.add(key));
  let rejected = 0;
  let queriesRun = 0;
  let queriesSkippedLowYield = 0;
  let consecutiveFailures = 0;
  let providerError: string | null = null;
  const yieldTracker = new QueryFamilyYieldTracker();

  const flushChunk = async (force = false) => {
    if (!options.onBatch) {
      pendingChunk.length = 0;
      return;
    }
    if (!force && pendingChunk.length < persistChunkSize) return;
    if (!pendingChunk.length) return;
    const batch = pendingChunk.splice(0, pendingChunk.length);
    await options.onBatch(batch);
  };

  const acceptHit = (hit: WebSearchResult): 'accepted' | 'rejected' | 'duplicate' => {
    const decision = assessWebCompanyCandidate(hit, plan);
    if (!decision.accepted) {
      rejected += 1;
      return 'rejected';
    }
    const keys = discoveryIdentityKeys(decision.result);
    if (keys.some((key) => seen.has(key))) return 'duplicate';
    keys.forEach((key) => seen.add(key));
    results.push(decision.result);
    pendingChunk.push(decision.result);
    return 'accepted';
  };

  for (let offset = 0; offset < queries.length && results.length < wanted; offset += concurrency) {
    if (offset > 0 && delayMs > 0) await sleep(delayMs);
    const batchVariants = queries.slice(offset, offset + concurrency).filter((variant) => {
      if (yieldTracker.shouldSkip(variant.familyId)) {
        queriesSkippedLowYield += 1;
        return false;
      }
      return true;
    });
    if (!batchVariants.length) continue;
    queriesRun += batchVariants.length;
    const outcomes = await Promise.all(batchVariants.map(async (variant) => {
      const controller = new AbortController();
      const timer = queryTimeoutMs === undefined
        ? null
        : setTimeout(() => controller.abort(), queryTimeoutMs);
      try {
        const hits = await search(variant.query, { signal: controller.signal });
        return { ok: true as const, hits, variant };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Web company discovery failed.';
        const timedOut = controller.signal.aborted
          || (error instanceof Error && (error.name === 'AbortError' || /timed out|timeout/i.test(error.message)));
        return {
          ok: false as const,
          message: timedOut ? 'Web search provider timed out.' : message,
          timedOut,
          variant,
        };
      } finally {
        if (timer) clearTimeout(timer);
      }
    }));

    for (const outcome of outcomes) {
      if (results.length >= wanted) break;
      if (!outcome.ok) {
        consecutiveFailures += 1;
        yieldTracker.record(outcome.variant.familyId, { raw: 0, acceptedNew: 0, duplicates: 0, rejected: 0 });
        if (
          /rate limit|429|plan limit|pay-as-you-go limit|quota|HTTP 432|HTTP 433/i.test(outcome.message)
          || consecutiveFailures >= maxConsecutiveFailures
        ) {
          providerError = outcome.message;
          await flushChunk(true);
          return withExpansionMetrics(results, rejected, providerError, queriesRun, expansion.metrics, queriesSkippedLowYield);
        }
        continue;
      }
      consecutiveFailures = 0;
      let acceptedNew = 0;
      let duplicates = 0;
      let rejectedHere = 0;
      for (const hit of outcome.hits) {
        if (results.length >= wanted) break;
        const status = acceptHit(hit);
        if (status === 'accepted') acceptedNew += 1;
        else if (status === 'duplicate') duplicates += 1;
        else rejectedHere += 1;
      }
      yieldTracker.record(outcome.variant.familyId, {
        raw: outcome.hits.length,
        acceptedNew,
        duplicates,
        rejected: rejectedHere,
      });
      await flushChunk(false);
    }
  }

  await flushChunk(true);
  return withExpansionMetrics(results, rejected, providerError, queriesRun, expansion.metrics, queriesSkippedLowYield);
}

function emptyCollection(): WebCompanyCollection {
  return {
    results: [],
    rejected: 0,
    providerError: null,
    queriesRun: 0,
    queriesSkippedDuplicate: 0,
    queriesSkippedBudget: 0,
    queriesSkippedLowYield: 0,
    queryFamiliesGenerated: 0,
    queriesGenerated: 0,
  };
}

function withExpansionMetrics(
  results: NormalizedSourceResult[],
  rejected: number,
  providerError: string | null,
  queriesRun: number,
  metrics: DiscoveryQueryExpansionMetrics,
  queriesSkippedLowYield: number,
): WebCompanyCollection {
  return {
    results,
    rejected,
    providerError,
    queriesRun,
    queriesSkippedDuplicate: metrics.duplicateQueriesSkipped,
    queriesSkippedBudget: metrics.queriesSkippedBudget,
    queriesSkippedLowYield,
    queryFamiliesGenerated: metrics.queryFamiliesGenerated,
    queriesGenerated: metrics.queriesGenerated,
  };
}

export function assessWebCompanyCandidate(
  hit: Pick<WebSearchResult, 'title' | 'url' | 'snippet' | 'source' | 'retrievedAt'>,
  plan: SearchPlan,
): { accepted: true; result: NormalizedSourceResult } | { accepted: false; reason: string } {
  let hostname = '';
  try {
    const parsed = new URL(hit.url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return { accepted: false, reason: 'INVALID_URL' };
    hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return { accepted: false, reason: 'INVALID_URL' };
  }
  if (JOB_BOARDS.some((host) => hostname === host || hostname.endsWith(`.${host}`))) return { accepted: false, reason: 'JOB_BOARD' };
  const rejectedUrl = rejectDiscoveryUrl(hit.url);
  if (rejectedUrl) return { accepted: false, reason: rejectedUrl };
  const text = `${hit.title} ${hit.snippet}`.replace(/\s+/g, ' ').trim();
  if (LISTING.test(text)) return { accepted: false, reason: 'GENERIC_LIST' };
  const name = companyNameFromTitle(hit.title);
  if (!name) return { accepted: false, reason: 'UNUSABLE_NAME' };
  const requested = plan.locations.find((location) => location.city || location.state || location.region || location.country || location.originalText);
  let location = requested ? locationEvidence(text, name, requested) : null;
  // State-only investor plans: SERP snippets often omit the state when the query already scoped it.
  // Accept plan-state context only when the snippet does not assert a different state (never invent a city).
  if (
    requested
    && !location
    && requested.state
    && !requested.city?.trim()
    && isInvestorPlan(plan)
    && !mentionsForeignState(text, requested.state)
  ) {
    const country = toCountryCode(requested.country) ?? (requested.country === 'US' ? 'US' : undefined);
    location = {
      state: requested.state,
      ...(country ? { country } : {}),
      evidence: 'plan_state_query_context',
    };
  }
  if (requested && !location) return { accepted: false, reason: 'OUTSIDE_REQUESTED_LOCATION' };
  const category = categoryDecision(text, plan, name);
  if (!category.matched) return { accepted: false, reason: category.reason };
  if ((plan.exclusions?.length ?? 0) > 0) {
    const exclusions = assessPlanExclusions({ exclusions: plan.exclusions ?? [], text, companyName: name, category: category.label });
    if (exclusions.some((item) => item.verdict === 'EXCLUDED')) {
      return { accepted: false, reason: 'EXCLUSION_MATCH' };
    }
  }
  const website = canonicalWebsite(hit.url);
  const externalId = createHash('sha256').update(`${name.toLowerCase()}|${hostname}`).digest('hex').slice(0, 40);
  return {
    accepted: true,
    result: {
      externalId,
      name,
      website,
      address: {
        ...(location?.city ? { city: location.city } : {}),
        ...(location?.state ? { state: location.state } : {}),
        ...(location?.country ? { country: location.country } : {}),
      },
      category: category.label,
      sourceUrl: hit.url,
      rawData: {
        title: hit.title,
        snippet: hit.snippet,
        source: hit.source,
        retrievedAt: hit.retrievedAt,
        ...(location ? { locationEvidence: location.evidence } : {}),
      },
    },
  };
}

function isInvestorPlan(plan: SearchPlan): boolean {
  const joined = [...plan.leadTypes, ...plan.industry].join(' ');
  return /real_estate_investor|house_flipper|fix_and_flip|buy_and_hold|brrrr|land_investor|commercial_real_estate_investor|cash_home_buyer|wholesaler/.test(joined);
}

function categoryDecision(text: string, plan: SearchPlan, companyName: string): { matched: true; label: string } | { matched: false; reason: string } {
  if (isInvestorPlan(plan)) {
    if (CONTRADICTION.test(text) && !REAL_ESTATE_SIGNAL.test(text)) return { matched: false, reason: 'NOT_REAL_ESTATE_INVESTOR' };
    if (!INVESTOR_SIGNAL.test(text)) return { matched: false, reason: 'NOT_REAL_ESTATE_INVESTOR' };
    return { matched: true, label: plan.leadTypes.find((type) => /investor|flip|hold|brrrr|buyer|wholesaler/.test(type)) ?? 'real_estate_investor' };
  }
  const assessment = assessCategoryEvidence({
    requested: [...plan.industry, ...plan.leadTypes],
    text,
    companyName,
  });
  if (assessment.verdict === 'NO_MATCH') return { matched: false, reason: assessment.reason };
  return { matched: true, label: plan.industry[0] ?? plan.leadTypes[0] ?? 'company' };
}

function companyNameFromTitle(title: string): string | null {
  const parts = title.split(/\s+[|–—]\s+|\s+-\s+/).map((part) => part.trim()).filter(Boolean);
  for (const part of parts) {
    if (part.length < 3 || part.length > 80) continue;
    if (/^(home|about|contact|linkedin|facebook|instagram|youtube|twitter|news|blog)$/i.test(part)) continue;
    if (LISTING.test(part)) continue;
    if (/\b(how to|what is|why |guide to|tips for|answered|quora|best agencies|top agencies)\b/i.test(part)) continue;
    return part;
  }
  return null;
}

function locationEvidence(text: string, companyName: string, requested: SearchLocation): { city?: string; state?: string; country?: string; evidence: string } | null {
  const withoutName = text.replace(new RegExp(escapeRegExp(companyName), 'ig'), ' ');
  const evidence = placeMentioned(withoutName, requested);
  const cityName = [requested.city, ...expansionCities(requested)]
    .filter((city): city is string => Boolean(city?.trim()))
    .find((city) => new RegExp(`\\b${escapeRegExp(city)}\\b`, 'i').test(withoutName));
  const original = requested.originalText?.trim();
  const originalHit = original && new RegExp(`\\b${escapeRegExp(original)}\\b`, 'i').test(withoutName) ? original : null;
  if (!evidence && !cityName && !originalHit) return null;
  const country = toCountryCode(requested.country);
  return {
    ...(cityName ? { city: cityName } : {}),
    ...(requested.state ? { state: requested.state } : {}),
    ...(country ? { country } : {}),
    evidence: cityName ?? evidence ?? originalHit ?? '',
  };
}

function mentionsForeignState(text: string, requestedState: string): boolean {
  const requested = requestedState.trim().toLowerCase();
  return US_STATE_NAMES.some((state) => {
    if (state.toLowerCase() === requested) return false;
    return new RegExp(`\\b${escapeRegExp(state)}\\b`, 'i').test(text);
  });
}

function canonicalWebsite(url: string): string {
  const parsed = new URL(url);
  parsed.hash = '';
  parsed.search = '';
  return parsed.toString().replace(/\/$/, '');
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
