import { buildGooglePlacesQuery } from './google-places.query-builder';

describe('buildGooglePlacesQuery', () => {
  it('creates a deterministic provider query from supported criteria', () => {
    expect(buildGooglePlacesQuery({
      industry: ['real_estate'],
      leadTypes: ['cash_home_buyer'],
      locations: [{ country: 'US', state: 'Texas' }],
      companyFields: [],
      unresolvedCriteria: [{ text: '1-50 employees', reason: 'provider unsupported' }],
    })).toBe('cash home buyer real estate Texas, US');
  });
});
