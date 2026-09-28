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

export function explicitResultCount(plan: Pick<SearchPlan, 'requestedCount' | 'maxResults'> | null | undefined): number | undefined {
  const value = plan?.requestedCount ?? plan?.maxResults;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return undefined;
  return Math.min(RESULT_SAFETY_CAP, value);
}

/** Uses an explicit prompt count as-is. 100 is only the default when the prompt has no count. */
export function discoveryTarget(plan: Pick<SearchPlan, 'requestedCount' | 'maxResults'> | null | undefined): number {
  return explicitResultCount(plan) ?? 100;
}

/** Distinct web queries allowed for a requested count. Scales past the old fixed 80-query ceiling. */
export function discoveryQueryBudget(requestedCount: number): number {
  const count = Math.max(1, Math.trunc(requestedCount));
  return Math.min(240, Math.max(4, Math.ceil(count / 2)));
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
