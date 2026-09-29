import type { SearchPlan } from './types/search-plan.types';

/** Operational safety cap. An explicit prompt count is never replaced by 100 below this cap. */
export const RESULT_SAFETY_CAP = 1000;

/** Used only when contact discovery runs and the plan did not name roles. Never invent industry-specific titles. */
export const DEFAULT_DECISION_MAKER_ROLES = [
  'CEO',
  'Founder',
  'Owner',
  'President',
  'Managing Director',
] as const;

const PERSON_FIELD_TOKENS = new Set([
  'personname', 'persontitle', 'personemail', 'personphone',
  'name', 'title', 'email', 'phone',
  'linkedin', 'facebook', 'instagram', 'youtube', 'twitter', 'x',
]);

export type CountIntent = NonNullable<SearchPlan['countIntent']>;

export function explicitResultCount(plan: Pick<SearchPlan, 'requestedCount' | 'maxResults'> | null | undefined): number | undefined {
  const value = plan?.requestedCount ?? plan?.maxResults;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return undefined;
  return Math.min(RESULT_SAFETY_CAP, value);
}

export function resolveCountIntent(plan: Pick<SearchPlan, 'countIntent' | 'requestedCount' | 'maxResults'> | null | undefined): CountIntent | undefined {
  if (explicitResultCount(plan) === undefined) return undefined;
  const intent = plan?.countIntent;
  if (intent === 'exact' || intent === 'maximum' || intent === 'minimum' || intent === 'approximate') return intent;
  return 'exact';
}

/**
 * How many candidates discovery should attempt to obtain.
 * - exact / maximum / approximate → the requested count
 * - minimum → modest over-seek within the safety cap (never fabricate; providers may still shortfall)
 * - no count → default 100
 */
export function discoveryTarget(plan: Pick<SearchPlan, 'requestedCount' | 'maxResults' | 'countIntent'> | null | undefined): number {
  const explicit = explicitResultCount(plan);
  if (explicit === undefined) return 100;
  const intent = resolveCountIntent(plan) ?? 'exact';
  if (intent === 'minimum') {
    return Math.min(RESULT_SAFETY_CAP, Math.max(explicit, Math.ceil(explicit * 1.25)));
  }
  return explicit;
}

/**
 * Hard ceiling on how many candidates may be accepted/persisted for this plan.
 * maximum/exact/approximate must not intentionally exceed the stated count.
 * minimum may fill above the stated floor (within RESULT_SAFETY_CAP).
 */
export function discoveryAcceptanceCap(plan: Pick<SearchPlan, 'requestedCount' | 'maxResults' | 'countIntent'> | null | undefined): number {
  const explicit = explicitResultCount(plan);
  if (explicit === undefined) return RESULT_SAFETY_CAP;
  const intent = resolveCountIntent(plan) ?? 'exact';
  if (intent === 'minimum') return RESULT_SAFETY_CAP;
  return explicit;
}

/** Honest shortfall vs the user-stated count (not vs an inflated discovery ceiling). */
export function countShortfall(
  plan: Pick<SearchPlan, 'requestedCount' | 'maxResults' | 'countIntent'> | null | undefined,
  candidates: number,
): number {
  const explicit = explicitResultCount(plan);
  if (explicit === undefined) return 0;
  return Math.max(0, explicit - Math.max(0, candidates));
}

/**
 * Honest shortfall of QUALIFIED leads vs the user-stated count.
 * Requested N never means N qualified — this metric keeps that distinction visible.
 */
export function qualifiedShortfall(
  plan: Pick<SearchPlan, 'requestedCount' | 'maxResults' | 'countIntent'> | null | undefined,
  qualifiedCount: number,
): number {
  return countShortfall(plan, qualifiedCount);
}

/** Distinct web queries allowed for a requested count. Scales with target; never invents results. */
export function discoveryQueryBudget(requestedCount: number): number {
  const count = Math.max(1, Math.trunc(requestedCount));
  // Allow enough geographic/category variants for large exact targets without unbounded spend.
  return Math.min(RESULT_SAFETY_CAP, Math.max(8, count * 2));
}

/** True only when the SearchPlan asked for a numeric employee-size bound. Qualitative "small" alone does not qualify. */
export function employeeSizeRequested(plan: unknown): boolean {
  if (!plan || typeof plan !== 'object') return false;
  const record = plan as {
    companySize?: { min?: unknown; max?: unknown; exact?: unknown };
    employeeSize?: { min?: unknown; max?: unknown; exact?: unknown };
    employeeRange?: { min?: unknown; max?: unknown; exact?: unknown };
  };
  return hasNumericSize(record.companySize) || hasNumericSize(record.employeeSize) || hasNumericSize(record.employeeRange);
}

function hasNumericSize(size?: { min?: unknown; max?: unknown; exact?: unknown }): boolean {
  return Boolean(size && (typeof size.min === 'number' || typeof size.max === 'number' || typeof size.exact === 'number'));
}

/** True when the SearchPlan asked for decision makers, person fields, email, or person social. */
export function contactDiscoveryRequested(plan: unknown): boolean {
  if (!plan || typeof plan !== 'object') return true;
  const record = plan as SearchPlan;
  if (hasExplicitContactSignals(record)) return true;
  if (record.targetType === 'QUALIFIED_LEADS') return true;
  // Company-only plans without contact/person signals skip decision-maker discovery.
  if (record.targetType === 'COMPANIES') return false;
  return false;
}

/** Plan roles when present; otherwise the default executive set for an attempted contact discovery. */
export function decisionMakerRolesForPlan(plan: unknown): string[] {
  if (!plan || typeof plan !== 'object') return [...DEFAULT_DECISION_MAKER_ROLES];
  const record = plan as SearchPlan;
  const roles = uniqueRoles([
    ...(record.decisionMakerRoles ?? []),
    ...(record.requiredRoles ?? []),
    ...(record.contactRequirements?.titles ?? []),
  ]);
  return roles.length ? roles : [...DEFAULT_DECISION_MAKER_ROLES];
}

function hasExplicitContactSignals(plan: SearchPlan): boolean {
  if ((plan.decisionMakerRoles?.length ?? 0) > 0) return true;
  if ((plan.requiredRoles?.length ?? 0) > 0) return true;
  if ((plan.contactRequirements?.titles?.length ?? 0) > 0) return true;
  if ((plan.contactRequirements?.fields?.length ?? 0) > 0) return true;
  if ((plan.personFields?.length ?? 0) > 0) return true;
  if (plan.emailRequirement?.requested) return true;
  const bags = [plan.requiredFields, plan.preferredFields, plan.optionalFields, plan.personFields, plan.contactRequirements?.fields];
  for (const bag of bags) {
    for (const field of bag ?? []) {
      if (PERSON_FIELD_TOKENS.has(String(field).toLowerCase().replace(/[^a-z]/g, ''))) return true;
    }
  }
  return false;
}

function uniqueRoles(roles: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const role of roles) {
    const cleaned = role?.trim();
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
  }
  return out;
}

/**
 * Latest-score filter semantics used by Leads API (and exports via the same filters).
 * Historical rows are ignored; only the newest score matters.
 */
export function latestScorePassesFilter(
  historicalScores: Array<{ score: number; calculatedAt: Date | string | number }>,
  bounds: { minScore?: number; maxScore?: number } = {},
): boolean {
  if (!historicalScores.length) {
    return bounds.minScore === undefined && bounds.maxScore === undefined;
  }
  const latest = [...historicalScores].sort((left, right) => {
    const leftAt = new Date(left.calculatedAt).getTime();
    const rightAt = new Date(right.calculatedAt).getTime();
    return rightAt - leftAt;
  })[0];
  if (bounds.minScore !== undefined && latest.score < bounds.minScore) return false;
  if (bounds.maxScore !== undefined && latest.score > bounds.maxScore) return false;
  return true;
}
