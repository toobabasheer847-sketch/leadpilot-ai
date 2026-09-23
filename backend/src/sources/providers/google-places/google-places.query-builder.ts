import { SearchPlan } from '../../../search/types/search-plan.types';

export function buildGooglePlacesQuery(plan: SearchPlan): string {
  const terms = [...plan.leadTypes, ...plan.industry]
    .map((term) => term.replaceAll('_', ' '));
  const location = plan.locations
    .map((item) => [item.city, item.state, item.country].filter(Boolean).join(', '))
    .filter(Boolean)
    .join('; ');

  return [...terms, location].filter(Boolean).join(' ').trim();
}
