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
