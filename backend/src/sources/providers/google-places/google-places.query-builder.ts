import { SearchPlan } from '../../../search/types/search-plan.types';
import { expansionCities } from '../../../search/search-plan.places';

/**
 * Build Google Places text-search queries from SearchPlan.
 * State-only plans fan out across expansion cities; city plans stay single-query.
 * Phrases come from leadTypes/industry — no hard-coded geography.
 */
export function buildGooglePlacesQueries(plan: SearchPlan): string[] {
  const terms = [...plan.leadTypes, ...plan.industry]
    .map((term) => term.replaceAll('_', ' ').trim())
    .filter(Boolean);
  const baseTerms = terms.length ? terms : ['company'];
  const location = plan.locations.find((item) => item.city || item.state || item.region || item.country);
  if (!location) {
    return [...new Set(baseTerms.map((term) => term.trim()).filter(Boolean))];
  }
  if (location.city?.trim()) {
    const place = [location.city, location.state, location.country].filter(Boolean).join(', ');
    return [...new Set(baseTerms.map((term) => `${term} ${place}`.replace(/\s+/g, ' ').trim()))];
  }
  const cities = expansionCities(location);
  if (!cities.length) {
    const place = [location.state, location.region, location.country].filter(Boolean).join(', ');
    return [...new Set(baseTerms.map((term) => `${term} ${place}`.replace(/\s+/g, ' ').trim()))];
  }
  const queries: string[] = [];
  const seen = new Set<string>();
  // Interleave cities × terms so coverage is geographic, not term-blocked.
  for (const city of cities) {
    for (const term of baseTerms) {
      const query = `${term} ${[city, location.state, location.country && location.country !== 'US' ? location.country : ''].filter(Boolean).join(', ')}`
        .replace(/\s+/g, ' ')
        .trim();
      const key = query.toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      queries.push(query);
    }
  }
  return queries;
}

/** @deprecated Prefer buildGooglePlacesQueries for multi-location fan-out. */
export function buildGooglePlacesQuery(plan: SearchPlan): string {
  return buildGooglePlacesQueries(plan)[0] ?? '';
}
