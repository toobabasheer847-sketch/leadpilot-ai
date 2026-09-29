import type { ClassificationCriteria } from './types/classification.types';
import type { SearchPlan } from '../../search/types/search-plan.types';

export type ClassificationMode = 'investor' | 'company';

/** Investor mode only when the plan/criteria actually target investor-style lead types. */
export function isInvestorClassificationMode(criteria: Pick<ClassificationCriteria, 'category' | 'targetType'> | null | undefined): boolean {
  if (!criteria) return false;
  const haystack = `${criteria.category ?? ''} ${criteria.targetType ?? ''}`.toLowerCase().replace(/_/g, ' ');
  return /\binvestor\b|\bbuyer\b|\bflip\b|\bhold\b|\bbrrrr?\b|\bcash home\b|\breal estate invest/i.test(haystack);
}

export function classificationModeFromCriteria(criteria: ClassificationCriteria | null | undefined): ClassificationMode {
  return isInvestorClassificationMode(criteria) ? 'investor' : 'company';
}

export function classificationModeFromPlan(plan: Pick<SearchPlan, 'leadTypes' | 'industry' | 'category'> | null | undefined): ClassificationMode {
  if (!plan) return 'company';
  if ((plan.leadTypes ?? []).some((type) => /investor|buyer|flip|hold|brrr|cash.?home/i.test(type))) return 'investor';
  return 'company';
}
