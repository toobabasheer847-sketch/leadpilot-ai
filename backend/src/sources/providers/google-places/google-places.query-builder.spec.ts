import { buildGooglePlacesQueries, buildGooglePlacesQuery } from './google-places.query-builder';

describe('buildGooglePlacesQueries', () => {
  it('fans out state-only plans across expansion cities and category terms', () => {
    const queries = buildGooglePlacesQueries({
      industry: ['real_estate'],
      leadTypes: ['cash_home_buyer'],
      locations: [{ country: 'US', state: 'Texas' }],
      companyFields: [],
      unresolvedCriteria: [{ text: '1-50 employees', reason: 'provider unsupported' }],
    });
    expect(queries.length).toBeGreaterThan(2);
    expect(queries.some((query) => /Houston/i.test(query))).toBe(true);
    expect(queries.some((query) => /Dallas/i.test(query))).toBe(true);
    expect(queries.some((query) => /cash home buyer/i.test(query))).toBe(true);
    expect(queries.every((query) => /Texas/i.test(query))).toBe(true);
    expect(queries.every((query) => !/1-50|employees/i.test(query))).toBe(true);
  });

  it('keeps a city plan as a single place without inventing employee filters', () => {
    expect(buildGooglePlacesQuery({
      industry: [],
      leadTypes: ['cash_home_buyer'],
      locations: [{ country: 'US', state: 'Texas', city: 'Austin' }],
      companySize: { min: 1, max: 50 },
      companyFields: [],
      unresolvedCriteria: [],
    })).toBe('cash home buyer Austin, Texas, US');
  });

  it('does not hard-code Texas phrases for non-Texas plans', () => {
    const queries = buildGooglePlacesQueries({
      industry: ['software'],
      leadTypes: [],
      locations: [{ country: 'US', state: 'California' }],
      companyFields: [],
      unresolvedCriteria: [],
    });
    expect(queries.every((query) => !/Texas/i.test(query))).toBe(true);
    expect(queries.some((query) => /Los Angeles|San Francisco/i.test(query))).toBe(true);
  });
});
