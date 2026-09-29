import { createHash } from 'node:crypto';
import { classifyOfficialWebsiteHost } from '../../../enrichment/website/official-website.validator';
import { assessCategoryEvidence } from '../../../search/category-evidence';
import { discoveryQueryBudget, discoveryTarget } from '../../../search/search-plan.limits';
import { assessPlanExclusions } from '../../../search/exclusion-evidence';
import { expansionCities, placeMentioned } from '../../../search/search-plan.places';
import { toCountryCode } from '../../location/location-evidence';
import type { SearchLocation, SearchPlan } from '../../../search/types/search-plan.types';
import { discoveryIdentityKeys } from '../../services/discovery-fallback';
import type { NormalizedSourceResult } from '../../types/source.types';
import type { WebSearchResult } from '../../../enrichment/website/web-search.types';

const JOB_BOARDS = ['indeed.com', 'ziprecruiter.com', 'monster.com', 'simplyhired.com', 'careerbuilder.com'];
const LISTING = /\b(top\s+\d+|best\s+\d+|list of|companies to watch|ranking of|directory of)\b/i;
const CONTRADICTION = /\b(restaurant|dentist|church|school|hotel|cafe|bar & grill|auto repair|salon)\b/i;
const REAL_ESTATE_SIGNAL = /\b(real[\s-]?estate|realty|propert(?:y|ies)|acquisition|multifamily|apartment buildings?)\b/i;
const INVESTOR_SIGNAL = /\b(real[\s-]?estate|realty|propert(?:y|ies)|investors?|investments?|acquisition|holdings|multifamily)\b/i;
const QUERY_TAILS = ['official website', 'headquarters', 'contact', 'about', 'team', 'founder'];

export interface WebCompanyCollection {
  results: NormalizedSourceResult[];
  rejected: number;
  providerError: string | null;
  queriesRun: number;
}

export function companyDiscoveryQueries(plan: SearchPlan, maxQueries: number): string[] {
  const phrases = searchPhrases(plan);
  const places = searchPlaces(plan);
  const queries: string[] = [];
  const seen = new Set<string>();
  const push = (parts: string[]) => {
    const query = parts.map((part) => part.trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ');
    const key = query.toLowerCase();
    if (!key || seen.has(key) || queries.length >= maxQueries) return;
    seen.add(key);
    queries.push(query);
  };
  for (const phrase of phrases) {
    for (const place of places) {
      push([phrase, place]);
      if (queries.length >= maxQueries) return queries;
    }
  }
  for (const phrase of phrases) {
    for (const place of places) {
      if (place) push([phrase, 'in', place]);
      if (queries.length >= maxQueries) return queries;
    }
  }
  for (const tail of QUERY_TAILS) {
    for (const phrase of phrases) {
      for (const place of places) {
        push([phrase, place, tail]);
        if (queries.length >= maxQueries) return queries;
      }
    }
  }
  return queries;
}

export function queryBudgetForPlan(plan: SearchPlan, remaining: number): number {
  // Use discoveryTarget so minimum intents get a slightly larger query budget.
  const requested = discoveryTarget(plan);
  return discoveryQueryBudget(Math.max(remaining, requested));
}

export async function collectWebCompanyCandidates(
  plan: SearchPlan,
  target: number,
  search: (query: string) => Promise<WebSearchResult[]>,
  options: { maxQueries?: number; delayMs?: number; sleep?: (ms: number) => Promise<void>; exclude?: NormalizedSourceResult[] } = {},
): Promise<WebCompanyCollection> {
  const wanted = Math.max(0, Math.trunc(target));
  if (wanted === 0) return { results: [], rejected: 0, providerError: null, queriesRun: 0 };
  const queries = companyDiscoveryQueries(plan, options.maxQueries ?? queryBudgetForPlan(plan, wanted));
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const delayMs = options.delayMs ?? 0;
  const results: NormalizedSourceResult[] = [];
  const seen = new Set<string>();
  for (const existing of options.exclude ?? []) discoveryIdentityKeys(existing).forEach((key) => seen.add(key));
  let rejected = 0;
  let queriesRun = 0;
  let consecutiveFailures = 0;
  for (const query of queries) {
    if (results.length >= wanted) break;
    if (queriesRun > 0 && delayMs > 0) await sleep(delayMs);
    queriesRun += 1;
    try {
      const hits = await search(query);
      consecutiveFailures = 0;
      for (const hit of hits) {
        const decision = assessWebCompanyCandidate(hit, plan);
        if (!decision.accepted) {
          rejected += 1;
          continue;
        }
        const keys = discoveryIdentityKeys(decision.result);
        if (keys.some((key) => seen.has(key))) continue;
        keys.forEach((key) => seen.add(key));
        results.push(decision.result);
        if (results.length >= wanted) break;
      }
    } catch (error) {
      consecutiveFailures += 1;
      const message = error instanceof Error ? error.message : 'Web company discovery failed.';
      if (
        /rate limit|429|timed out|timeout|plan limit|pay-as-you-go limit|quota|HTTP 432|HTTP 433/i.test(message)
        || consecutiveFailures >= 3
      ) {
        return { results, rejected, providerError: message, queriesRun };
      }
    }
  }
  return { results, rejected, providerError: null, queriesRun };
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
  const hostReason = classifyOfficialWebsiteHost(hostname);
  if (hostReason) return { accepted: false, reason: hostReason };
  const text = `${hit.title} ${hit.snippet}`.replace(/\s+/g, ' ').trim();
  if (LISTING.test(text)) return { accepted: false, reason: 'GENERIC_LIST' };
  const name = companyNameFromTitle(hit.title);
  if (!name) return { accepted: false, reason: 'UNUSABLE_NAME' };
  const requested = plan.locations.find((location) => location.city || location.state || location.region || location.country || location.originalText);
  const location = requested ? locationEvidence(text, name, requested) : null;
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

function searchPhrases(plan: SearchPlan): string[] {
  const investor = isInvestorPlan(plan);
  if (investor) return ['real estate investment company', 'real estate investor', 'property investment firm'];
  const phrases = [...plan.industry, ...plan.leadTypes].map((term) => term.replace(/_/g, ' ').trim()).filter(Boolean);
  const base = phrases.length ? phrases : ['company'];
  return [...new Set(base.flatMap((phrase) => [phrase, `${phrase} company`]))];
}

function searchPlaces(plan: SearchPlan): string[] {
  const location = plan.locations.find((item) => item.city || item.state || item.region || item.country || item.originalText);
  if (!location) return [''];
  if (location.city?.trim()) return [placeLabel(location)];
  const cities = expansionCities(location);
  if (!cities.length) return [placeLabel(location)];
  return cities.map((city) => [city, location.state, location.country && location.country !== 'US' ? location.country : ''].filter(Boolean).join(' '));
}

function placeLabel(location: SearchLocation): string {
  const structured = [location.city, location.state, location.region, location.country].filter((part) => Boolean(part?.trim()));
  if (structured.length) return structured.join(' ');
  return location.originalText?.trim() ?? '';
}

function isInvestorPlan(plan: SearchPlan): boolean {
  const joined = [...plan.leadTypes, ...plan.industry].join(' ');
  return /real_estate_investor|house_flipper|fix_and_flip|buy_and_hold|brrrr|land_investor|commercial_real_estate_investor|cash_home_buyer/.test(joined);
}

function categoryDecision(text: string, plan: SearchPlan, companyName: string): { matched: true; label: string } | { matched: false; reason: string } {
  if (isInvestorPlan(plan)) {
    if (CONTRADICTION.test(text) && !REAL_ESTATE_SIGNAL.test(text)) return { matched: false, reason: 'NOT_REAL_ESTATE_INVESTOR' };
    if (!INVESTOR_SIGNAL.test(text)) return { matched: false, reason: 'NOT_REAL_ESTATE_INVESTOR' };
    return { matched: true, label: plan.leadTypes.find((type) => /investor|flip|hold|brrrr|buyer/.test(type)) ?? 'real_estate_investor' };
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

function canonicalWebsite(url: string): string {
  const parsed = new URL(url);
  parsed.hash = '';
  parsed.search = '';
  return parsed.toString().replace(/\/$/, '');
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
