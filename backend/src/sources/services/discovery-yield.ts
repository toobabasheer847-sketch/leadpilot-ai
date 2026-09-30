import type { SearchPlan } from '../../search/types/search-plan.types';
import type { DiscoveryQueryVariant } from './discovery-query-expansion';
import { expandDiscoveryPhrases, normalizeQuerySignature } from './discovery-query-expansion';

/**
 * Phase T — discovery yield / rejection observability and adaptive prioritization.
 * Never mutates SearchPlan semantics; never relaxes assessment gates.
 */

export const DISCOVERY_REJECTION_REASONS = [
  'WRONG_LOCATION',
  'WRONG_CATEGORY',
  'EXCLUDED_CATEGORY',
  'DIRECTORY_OR_LISTICLE',
  'INVALID_COMPANY_IDENTITY',
  'DUPLICATE',
  'INSUFFICIENT_COMPANY_EVIDENCE',
  'PROVIDER_RESULT_INVALID',
  'PROVIDER_QUOTA',
  'PROVIDER_RATE_LIMIT',
  'OTHER',
] as const;

export type DiscoveryRejectionReason = (typeof DISCOVERY_REJECTION_REASONS)[number];

export const DISCOVERY_STOP_REASONS = [
  'ACCEPTANCE_CAP_REACHED',
  'QUERY_BUDGET_EXHAUSTED',
  'PROVIDER_QUOTA',
  'PROVIDER_RATE_LIMIT',
  'PROVIDER_UNAVAILABLE',
  'LOCATION_RESOLUTION_FAILED',
  'LOW_YIELD_EXHAUSTED',
  'INSUFFICIENT_VALID_CANDIDATES',
  'ALL_PROVIDERS_EXHAUSTED',
] as const;

export type DiscoveryStopReason = (typeof DISCOVERY_STOP_REASONS)[number];

export interface DiscoveryFamilyYieldStats {
  familyId: string;
  categoryPhrase: string;
  locationVariant: string;
  queriesIssued: number;
  queriesSkipped: number;
  rawHits: number;
  usableCandidates: number;
  newlyAccepted: number;
  duplicates: number;
  rejected: number;
  rejectionReasons: Partial<Record<DiscoveryRejectionReason, number>>;
  consecutiveZeroNew: number;
  required: boolean;
}

export interface DiscoveryYieldSnapshot {
  families: DiscoveryFamilyYieldStats[];
  rejectionCounts: Partial<Record<DiscoveryRejectionReason, number>>;
  locationYield: Array<{ locationVariant: string; newlyAccepted: number; rawHits: number; duplicates: number; rejected: number }>;
  categoryYield: Array<{ categoryPhrase: string; newlyAccepted: number; rawHits: number; duplicates: number; rejected: number }>;
  queriesIssued: number;
  queriesSkippedLowYield: number;
  newlyAccepted: number;
  duplicates: number;
  rejected: number;
  acceptanceRate: number;
  yieldPerQuery: number;
  stopReason: DiscoveryStopReason | null;
  rejectionSummary: string;
  locationYieldSummary: string;
  categoryYieldSummary: string;
}

/** Map existing assess/gate reason strings onto Phase T machine-readable categories. */
export function classifyDiscoveryRejectionReason(reason: string | null | undefined): DiscoveryRejectionReason {
  const value = (reason ?? '').trim();
  if (!value) return 'OTHER';
  if (value === 'DUPLICATE' || /^DUPLICATE$/i.test(value) || /duplicate/i.test(value)) return 'DUPLICATE';
  if (value === 'OUTSIDE_REQUESTED_LOCATION' || /wrong_?location|outside_requested_location/i.test(value)) {
    return 'WRONG_LOCATION';
  }
  if (value === 'EXCLUSION_MATCH' || /^EXCLUDED_CATEGORY$/i.test(value) || /exclu/i.test(value)) {
    return 'EXCLUDED_CATEGORY';
  }
  if (
    value === 'NOT_REAL_ESTATE_INVESTOR'
    || value === 'NO_MATCH'
    || value === 'CATEGORY_MISMATCH'
    || value === 'CATEGORY_CONFLICT'
    || /^WRONG_CATEGORY$/i.test(value)
    || /wrong_?category|not_real_estate/i.test(value)
  ) {
    return 'WRONG_CATEGORY';
  }
  if (
    value === 'GENERIC_LIST'
    || value === 'DIRECTORY'
    || value === 'REVIEW_SITE'
    || value === 'JOB_BOARD'
    || value === 'NEWS_ARTICLE'
    || value === 'MARKETPLACE'
    || value === 'GENERIC_THIRD_PARTY_PAGE'
    || /listicle|directory|job_board/i.test(value)
  ) {
    return 'DIRECTORY_OR_LISTICLE';
  }
  if (
    value === 'INVALID_URL'
    || value === 'UNUSABLE_NAME'
    || value === 'SOCIAL_PROFILE'
    || value === 'PROXY_OR_FILING'
    || /invalid_company|unusable_name|invalid_url/i.test(value)
  ) {
    return 'INVALID_COMPANY_IDENTITY';
  }
  if (/insufficient|missing.?evidence/i.test(value)) return 'INSUFFICIENT_COMPANY_EVIDENCE';
  if (/provider.?result.?invalid|malformed/i.test(value)) return 'PROVIDER_RESULT_INVALID';
  if (/plan limit|pay-as-you-go|quota|HTTP 432|HTTP 433|RESOURCE_EXHAUSTED/i.test(value)) return 'PROVIDER_QUOTA';
  if (/rate limit|429/i.test(value)) return 'PROVIDER_RATE_LIMIT';
  return 'OTHER';
}

export function requiredDiscoveryCategoryPhrases(plan: SearchPlan): Set<string> {
  const required = new Set<string>();
  for (const type of plan.leadTypes) {
    const phrase = type.replace(/_/g, ' ').trim().toLowerCase();
    if (phrase) required.add(normalizeQuerySignature(phrase));
  }
  // Explicit specializations from lead types must stay available even under low yield.
  for (const phrase of expandDiscoveryPhrases(plan)) {
    const normalized = normalizeQuerySignature(phrase);
    if (!normalized) continue;
    if (plan.leadTypes.some((type) => {
      const token = type.replace(/_/g, ' ').toLowerCase();
      return normalized.includes(token) || token.split(/\s+/).every((part) => part.length < 3 || normalized.includes(part));
    })) {
      required.add(normalized);
    }
  }
  return required;
}

export function isRequiredDiscoveryFamily(familyId: string, requiredPhrases: Set<string>): boolean {
  const category = familyId.split('|')[0] ?? '';
  if (!category) return false;
  if (requiredPhrases.has(category)) return true;
  for (const required of requiredPhrases) {
    if (required && (category.includes(required) || required.includes(category))) return true;
  }
  return false;
}

/**
 * Phase T adaptive yield tracker.
 * Prioritizes useful/new company yield only — raw hit volume does not promote a family.
 */
export class DiscoveryYieldTracker {
  private readonly families = new Map<string, DiscoveryFamilyYieldStats>();
  private readonly rejectionCounts: Partial<Record<DiscoveryRejectionReason, number>> = {};
  private queriesIssued = 0;
  private queriesSkippedLowYield = 0;
  private newlyAccepted = 0;
  private duplicates = 0;
  private rejected = 0;
  private stopReason: DiscoveryStopReason | null = null;
  private readonly requiredPhrases: Set<string>;

  private static readonly STOP_AFTER_ZERO_BATCHES = 3;

  constructor(plan: SearchPlan) {
    this.requiredPhrases = requiredDiscoveryCategoryPhrases(plan);
  }

  ensureFamily(variant: Pick<DiscoveryQueryVariant, 'familyId' | 'categoryPhrase' | 'locationVariant'>) {
    if (this.families.has(variant.familyId)) return this.families.get(variant.familyId)!;
    const stats: DiscoveryFamilyYieldStats = {
      familyId: variant.familyId,
      categoryPhrase: variant.categoryPhrase,
      locationVariant: variant.locationVariant,
      queriesIssued: 0,
      queriesSkipped: 0,
      rawHits: 0,
      usableCandidates: 0,
      newlyAccepted: 0,
      duplicates: 0,
      rejected: 0,
      rejectionReasons: {},
      consecutiveZeroNew: 0,
      required: isRequiredDiscoveryFamily(variant.familyId, this.requiredPhrases),
    };
    this.families.set(variant.familyId, stats);
    return stats;
  }

  recordIssued(variant: DiscoveryQueryVariant) {
    const family = this.ensureFamily(variant);
    family.queriesIssued += 1;
    this.queriesIssued += 1;
  }

  recordSkippedLowYield(variant: DiscoveryQueryVariant) {
    const family = this.ensureFamily(variant);
    family.queriesSkipped += 1;
    this.queriesSkippedLowYield += 1;
  }

  recordBatch(
    variant: DiscoveryQueryVariant,
    input: {
      raw: number;
      newlyAccepted: number;
      duplicates: number;
      rejected: number;
      rejectionReasons?: Partial<Record<DiscoveryRejectionReason, number>>;
    },
  ) {
    const family = this.ensureFamily(variant);
    family.rawHits += input.raw;
    family.newlyAccepted += input.newlyAccepted;
    // Usable = passed assessment (new + duplicate identity). Raw hits alone do not count.
    family.usableCandidates += input.newlyAccepted + input.duplicates;
    family.duplicates += input.duplicates;
    family.rejected += input.rejected;
    family.consecutiveZeroNew = input.newlyAccepted > 0 ? 0 : family.consecutiveZeroNew + 1;
    for (const [reason, count] of Object.entries(input.rejectionReasons ?? {}) as Array<[DiscoveryRejectionReason, number]>) {
      family.rejectionReasons[reason] = (family.rejectionReasons[reason] ?? 0) + count;
      this.rejectionCounts[reason] = (this.rejectionCounts[reason] ?? 0) + count;
    }
    this.newlyAccepted += input.newlyAccepted;
    this.duplicates += input.duplicates;
    this.rejected += input.rejected;
  }

  recordProviderFailure(reason: DiscoveryRejectionReason) {
    this.rejectionCounts[reason] = (this.rejectionCounts[reason] ?? 0) + 1;
  }

  shouldSkip(familyId: string): boolean {
    const family = this.families.get(familyId);
    if (!family) return false;
    if (family.required) return false;
    return family.consecutiveZeroNew >= DiscoveryYieldTracker.STOP_AFTER_ZERO_BATCHES;
  }

  /**
   * Priority for remaining budget.
   * Raw hits alone do not raise score — only newly accepted companies do.
   * Duplicate-heavy families are demoted.
   */
  priorityScore(familyId: string): number {
    const family = this.families.get(familyId);
    if (!family) return 0;
    if (family.required && family.queriesIssued === 0) return 1_000;
    const acceptedScore = family.newlyAccepted * 100;
    const duplicatePenalty = family.duplicates * 15;
    const rejectedPenalty = family.rejected * 2;
    const rawNoisePenalty = family.rawHits > 0 && family.newlyAccepted === 0 ? family.rawHits * 3 : 0;
    const requiredBoost = family.required ? 25 : 0;
    return acceptedScore - duplicatePenalty - rejectedPenalty - rawNoisePenalty + requiredBoost;
  }

  /** Reorder remaining variants so high-yield / required families consume remaining budget first. */
  prioritizeVariants(variants: DiscoveryQueryVariant[]): DiscoveryQueryVariant[] {
    return [...variants].sort((left, right) => {
      const scoreDelta = this.priorityScore(right.familyId) - this.priorityScore(left.familyId);
      if (scoreDelta !== 0) return scoreDelta;
      const leftRequired = this.ensureFamily(left).required ? 1 : 0;
      const rightRequired = this.ensureFamily(right).required ? 1 : 0;
      return rightRequired - leftRequired;
    });
  }

  setStopReason(reason: DiscoveryStopReason) {
    if (!this.stopReason) this.stopReason = reason;
  }

  snapshot(): DiscoveryYieldSnapshot {
    const families = [...this.families.values()];
    const locationMap = new Map<string, { locationVariant: string; newlyAccepted: number; rawHits: number; duplicates: number; rejected: number }>();
    const categoryMap = new Map<string, { categoryPhrase: string; newlyAccepted: number; rawHits: number; duplicates: number; rejected: number }>();
    for (const family of families) {
      const location = locationMap.get(family.locationVariant) ?? {
        locationVariant: family.locationVariant || 'none',
        newlyAccepted: 0,
        rawHits: 0,
        duplicates: 0,
        rejected: 0,
      };
      location.newlyAccepted += family.newlyAccepted;
      location.rawHits += family.rawHits;
      location.duplicates += family.duplicates;
      location.rejected += family.rejected;
      locationMap.set(family.locationVariant, location);

      const category = categoryMap.get(family.categoryPhrase) ?? {
        categoryPhrase: family.categoryPhrase || 'none',
        newlyAccepted: 0,
        rawHits: 0,
        duplicates: 0,
        rejected: 0,
      };
      category.newlyAccepted += family.newlyAccepted;
      category.rawHits += family.rawHits;
      category.duplicates += family.duplicates;
      category.rejected += family.rejected;
      categoryMap.set(family.categoryPhrase, category);
    }

    const locationYield = [...locationMap.values()].sort((a, b) => b.newlyAccepted - a.newlyAccepted);
    const categoryYield = [...categoryMap.values()].sort((a, b) => b.newlyAccepted - a.newlyAccepted);
    const rejectionSummary = Object.entries(this.rejectionCounts)
      .filter(([, count]) => (count ?? 0) > 0)
      .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
      .map(([reason, count]) => `${reason}:${count}`)
      .join(' | ');
    const locationYieldSummary = locationYield
      .slice(0, 8)
      .map((row) => `${row.locationVariant || 'none'}:${row.newlyAccepted}`)
      .join(' | ');
    const categoryYieldSummary = categoryYield
      .slice(0, 8)
      .map((row) => `${row.categoryPhrase}:${row.newlyAccepted}`)
      .join(' | ');

    return {
      families,
      rejectionCounts: { ...this.rejectionCounts },
      locationYield,
      categoryYield,
      queriesIssued: this.queriesIssued,
      queriesSkippedLowYield: this.queriesSkippedLowYield,
      newlyAccepted: this.newlyAccepted,
      duplicates: this.duplicates,
      rejected: this.rejected,
      acceptanceRate: this.queriesIssued > 0 ? Number((this.newlyAccepted / this.queriesIssued).toFixed(4)) : 0,
      yieldPerQuery: this.queriesIssued > 0 ? Number((this.newlyAccepted / this.queriesIssued).toFixed(4)) : 0,
      stopReason: this.stopReason,
      rejectionSummary,
      locationYieldSummary,
      categoryYieldSummary,
    };
  }
}

export function classifyDiscoveryStopReason(input: {
  accepted: number;
  acceptanceCap: number;
  queriesIssued: number;
  queryBudget: number;
  providerError?: string | null;
  lowYieldExhausted?: boolean;
  allProvidersUnavailable?: boolean;
}): DiscoveryStopReason {
  if (input.accepted >= input.acceptanceCap && input.acceptanceCap > 0) return 'ACCEPTANCE_CAP_REACHED';
  if (input.allProvidersUnavailable) return 'ALL_PROVIDERS_EXHAUSTED';
  const providerReason = classifyDiscoveryRejectionReason(input.providerError);
  if (providerReason === 'PROVIDER_QUOTA') return 'PROVIDER_QUOTA';
  if (providerReason === 'PROVIDER_RATE_LIMIT') return 'PROVIDER_RATE_LIMIT';
  if (/location resolution/i.test(input.providerError ?? '')) return 'LOCATION_RESOLUTION_FAILED';
  if (input.providerError) return 'PROVIDER_UNAVAILABLE';
  if (input.queriesIssued >= input.queryBudget && input.queryBudget > 0) return 'QUERY_BUDGET_EXHAUSTED';
  if (input.lowYieldExhausted) return 'LOW_YIELD_EXHAUSTED';
  return 'INSUFFICIENT_VALID_CANDIDATES';
}
