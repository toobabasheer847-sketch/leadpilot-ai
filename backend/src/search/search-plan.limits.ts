import type { SearchPlan } from './types/search-plan.types';

/** Operational safety cap. An explicit prompt count is never replaced by 100 below this cap. */
export const RESULT_SAFETY_CAP = 1000;

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
