import { expansionCities } from '../../search/search-plan.places';
import type { SearchLocation, SearchPlan } from '../../search/types/search-plan.types';

/**
 * Phase S — bounded discovery query expansion.
 * Expands provider queries only; never mutates SearchPlan location/category semantics.
 */

const FORBIDDEN_EXPANSION = [
  'realtor', 'real estate agent', 'brokerage', 'mortgage', 'property management', 'property manager',
  'attorney', 'lawyer', 'photographer', 'software company', 'construction company', 'agency',
];

const MAX_PHRASES = 16;
const MAX_LOCATION_VARIANTS = 12;

export interface DiscoveryQueryVariant {
  query: string;
  signature: string;
  categoryPhrase: string;
  locationVariant: string;
  familyId: string;
}

export interface DiscoveryQueryExpansionMetrics {
  queryFamiliesGenerated: number;
  queriesGenerated: number;
  duplicateQueriesSkipped: number;
  queriesSkippedBudget: number;
}

export interface DiscoveryQueryExpansionResult {
  variants: DiscoveryQueryVariant[];
  phrases: string[];
  locationVariants: string[];
  metrics: DiscoveryQueryExpansionMetrics;
}

export function normalizeQuerySignature(query: string): string {
  return query
    .toLowerCase()
    .replace(/["'`]/g, '')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Semantically equivalent discovery phrases derived from SearchPlan — not a plan mutation. */
export function expandDiscoveryPhrases(plan: SearchPlan): string[] {
  const phrases: string[] = [];
  const push = (phrase: string) => {
    const cleaned = phrase.replace(/\s+/g, ' ').trim();
    if (!cleaned || phrases.length >= MAX_PHRASES) return;
    if (isForbiddenPhrase(cleaned, plan)) return;
    if (phrases.some((existing) => existing.toLowerCase() === cleaned.toLowerCase())) return;
    phrases.push(cleaned);
  };

  const types = plan.leadTypes.map((type) => type.toLowerCase());
  const industry = plan.industry.map((item) => item.toLowerCase());
  const intent = `${plan.searchIntent ?? ''} ${plan.originalPrompt ?? ''}`.toLowerCase();
  const investor = isInvestorPlan(plan) || /real[\s-]?estate invest|cash home buy|fix(?:\s|-)?and(?:\s|-)?flip|wholesal/.test(intent);

  if (investor) {
    if (types.some((type) => /cash_home_buyer/.test(type)) || /cash home buy|cash buyer|we buy houses/.test(intent)) {
      push('cash home buyer');
      push('cash buyer');
      push('we buy houses');
    }
    if (types.some((type) => /fix_and_flip|house_flipper/.test(type)) || /fix(?:\s|-)?and(?:\s|-)?flip|house flipper/.test(intent)) {
      push('fix and flip');
      push('house flipper');
      push('fix & flip investor');
    }
    if (types.some((type) => /wholesaler|wholesaling/.test(type)) || /wholesal/.test(intent)) {
      push('real estate wholesaler');
      push('property wholesaler');
      push('house wholesaler');
      push('real estate wholesaling');
    }
    if (
      types.some((type) => /real_estate_investor/.test(type))
      || industry.some((item) => /real_estate/.test(item))
      || /real[\s-]?estate invest|property invest/.test(intent)
    ) {
      push('real estate investor');
      push('real estate investment company');
      push('property investor');
      push('property investment firm');
    }
    if (types.some((type) => /buy_and_hold|brrrr/.test(type)) || /\bbrrrr?\b|buy and hold/.test(intent)) {
      push('buy and hold investor');
      push('BRRRR investor');
    }
    if (types.some((type) => /land_investor/.test(type))) {
      push('land investor');
      push('land investment company');
    }
    if (types.some((type) => /commercial_real_estate_investor/.test(type))) {
      push('commercial real estate investor');
      push('commercial property investor');
    }
    if (!phrases.length) {
      push('real estate investment company');
      push('real estate investor');
      push('property investor');
    }
    return phrases;
  }

  for (const term of [...plan.industry, ...plan.leadTypes]) {
    const phrase = term.replace(/_/g, ' ').trim();
    if (!phrase) continue;
    push(phrase);
    push(`${phrase} company`);
  }
  if (!phrases.length) push('company');
  return phrases;
}

/** Provider-only location labels. SearchPlan.locations stay unchanged. */
export function expandDiscoveryLocationVariants(plan: SearchPlan): string[] {
  const location = plan.locations.find((item) => item.city || item.state || item.region || item.country || item.originalText);
  if (!location) return [''];
  if (location.city?.trim()) return [placeLabel(location)];
  const cities = expansionCities(location).slice(0, MAX_LOCATION_VARIANTS);
  if (!cities.length) return [placeLabel(location)];
  const stateCountry = [location.state, location.country && location.country !== 'US' ? location.country : '']
    .filter(Boolean)
    .join(' ');
  // Cities first for geographic coverage; state-level label is an additional provider-only variant.
  const variants = [
    ...cities.map((city) => [city, stateCountry].filter(Boolean).join(' ')),
    placeLabel(location),
  ];
  return [...new Set(variants.map((value) => value.replace(/\s+/g, ' ').trim()).filter(Boolean))];
}

export function buildExpandedDiscoveryQueries(
  plan: SearchPlan,
  maxQueries: number,
  options: { round?: number; includeTails?: boolean } = {},
): DiscoveryQueryExpansionResult {
  const budget = Math.max(0, Math.trunc(maxQueries));
  const phrases = [...expandDiscoveryPhrases(plan), ...roundExpansionPhrases(plan, options.round ?? 0)];
  const uniquePhrases = [...new Set(phrases)].slice(0, MAX_PHRASES);
  const locations = expandDiscoveryLocationVariants(plan);
  const seen = new Set<string>();
  const variants: DiscoveryQueryVariant[] = [];
  let duplicateQueriesSkipped = 0;
  let queriesSkippedBudget = 0;

  const push = (categoryPhrase: string, locationVariant: string, parts: string[]): boolean => {
    if (variants.length >= budget) {
      queriesSkippedBudget += 1;
      return false;
    }
    const query = parts.map((part) => part.trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    if (!query) return true;
    const signature = normalizeQuerySignature(query);
    if (!signature) return true;
    if (seen.has(signature)) {
      duplicateQueriesSkipped += 1;
      return true;
    }
    seen.add(signature);
    variants.push({
      query,
      signature,
      categoryPhrase,
      locationVariant,
      familyId: `${normalizeQuerySignature(categoryPhrase)}|${normalizeQuerySignature(locationVariant) || 'none'}`,
    });
    return true;
  };

  const tails = options.includeTails === false
    ? []
    : (options.round ?? 0) === 0
      ? ['official website', 'headquarters', 'contact', 'LLC', 'Inc']
      : ['official website', 'owner operator', 'buying houses', 'residential investor', 'LLC'];

  // Tier 1–2: phrase × location interleave for geographic + category coverage.
  for (let offset = 0; offset < uniquePhrases.length; offset += 1) {
    for (let placeIndex = 0; placeIndex < locations.length; placeIndex += 1) {
      const phrase = uniquePhrases[(placeIndex + offset) % uniquePhrases.length];
      const place = locations[placeIndex] ?? '';
      if (!phrase) continue;
      if (!push(phrase, place, [phrase, place])) break;
      if (place && !push(phrase, place, [phrase, 'in', place])) break;
    }
    if (variants.length >= budget) break;
  }

  // Tier 3: quoted company-style variants.
  for (const place of locations) {
    for (const phrase of uniquePhrases) {
      if (variants.length >= budget) break;
      push(phrase, place, place
        ? [`"${phrase}"`, place, 'company OR LLC OR Inc']
        : [`"${phrase}"`, 'company OR LLC OR Inc']);
    }
  }

  for (const place of locations) {
    for (const phrase of uniquePhrases) {
      for (const tail of tails) {
        if (variants.length >= budget) break;
        push(phrase, place, [phrase, place, tail]);
      }
    }
  }

  const families = new Set(variants.map((variant) => variant.familyId));
  return {
    variants,
    phrases: uniquePhrases,
    locationVariants: locations,
    metrics: {
      queryFamiliesGenerated: families.size,
      queriesGenerated: variants.length,
      duplicateQueriesSkipped,
      queriesSkippedBudget,
    },
  };
}

export function googlePlacesExpandedTerms(plan: SearchPlan): string[] {
  const expanded = expandDiscoveryPhrases(plan);
  if (expanded.length) return expanded;
  const fallback = [...plan.leadTypes, ...plan.industry]
    .map((term) => term.replaceAll('_', ' ').trim())
    .filter(Boolean);
  return fallback.length ? fallback : ['company'];
}

/** Adaptive yield tracker for query families (Phase S). */
export class QueryFamilyYieldTracker {
  private readonly families = new Map<string, {
    consecutiveZeroNew: number;
    raw: number;
    acceptedNew: number;
    duplicates: number;
    rejected: number;
  }>();

  private static readonly STOP_AFTER_ZERO_BATCHES = 3;

  record(familyId: string, input: { raw: number; acceptedNew: number; duplicates: number; rejected: number }) {
    const current = this.families.get(familyId) ?? {
      consecutiveZeroNew: 0,
      raw: 0,
      acceptedNew: 0,
      duplicates: 0,
      rejected: 0,
    };
    current.raw += input.raw;
    current.acceptedNew += input.acceptedNew;
    current.duplicates += input.duplicates;
    current.rejected += input.rejected;
    current.consecutiveZeroNew = input.acceptedNew > 0 ? 0 : current.consecutiveZeroNew + 1;
    this.families.set(familyId, current);
  }

  shouldSkip(familyId: string): boolean {
    const current = this.families.get(familyId);
    return Boolean(current && current.consecutiveZeroNew >= QueryFamilyYieldTracker.STOP_AFTER_ZERO_BATCHES);
  }

  summary() {
    let lowYieldSkipped = 0;
    for (const value of this.families.values()) {
      if (value.consecutiveZeroNew >= QueryFamilyYieldTracker.STOP_AFTER_ZERO_BATCHES) lowYieldSkipped += 1;
    }
    return {
      familiesTracked: this.families.size,
      lowYieldFamilies: lowYieldSkipped,
    };
  }
}

function roundExpansionPhrases(plan: SearchPlan, round: number): string[] {
  if (round <= 0 || !isInvestorPlan(plan)) return [];
  const batches = [
    ['we buy houses', 'cash buyers', 'fix flip investors'],
    ['residential wholesale', 'creative finance buyer', 'distressed property buyer'],
    ['turnkey rental investor', 'BRRRR investor', 'multifamily acquisition'],
    ['off market buyer', 'novation wholesaler', 'subject to buyer'],
  ];
  return (batches[Math.min(round, batches.length) - 1] ?? []).filter((phrase) => !isForbiddenPhrase(phrase, plan));
}

function isInvestorPlan(plan: SearchPlan): boolean {
  const joined = [...plan.leadTypes, ...plan.industry, plan.searchIntent ?? '', plan.originalPrompt ?? ''].join(' ');
  return /real_estate_investor|house_flipper|fix_and_flip|buy_and_hold|brrrr|land_investor|commercial_real_estate_investor|cash_home_buyer|wholesaler|real[\s-]?estate invest|cash home buy|fix(?:\s|-)?and(?:\s|-)?flip|wholesal/.test(joined);
}

function isForbiddenPhrase(phrase: string, plan: SearchPlan): boolean {
  const lower = phrase.toLowerCase();
  const exclusions = (plan.exclusions ?? []).map((item) => item.toLowerCase());
  if (exclusions.some((item) => item && lower.includes(item))) return true;
  // Never expand into unrelated verticals unless the plan explicitly requested them.
  const requested = [...plan.leadTypes, ...plan.industry, plan.searchIntent ?? ''].join(' ').toLowerCase();
  return FORBIDDEN_EXPANSION.some((forbidden) => {
    if (!lower.includes(forbidden)) return false;
    return !requested.includes(forbidden);
  });
}

function placeLabel(location: SearchLocation): string {
  const structured = [location.city, location.state, location.region, location.country].filter((part) => Boolean(part?.trim()));
  if (structured.length) return structured.join(' ');
  return location.originalText?.trim() ?? '';
}
