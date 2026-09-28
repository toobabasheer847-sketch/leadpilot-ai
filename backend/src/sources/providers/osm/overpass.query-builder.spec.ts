import { SearchPlan } from '../../../search/types/search-plan.types';
import { companySizeFit } from '../../../qualification/engine/qualification-engine';
import { assertLocationText, buildOverpassQuery, coordinateWithinRequestedState, investorCandidateAllowed, matchesRequestedState, MAX_DISCOVERY_PARTITIONS, searchWindows } from './overpass.query-builder';

const bbox = { south: 25.7, west: -80.3, north: 25.9, east: -80.1 };

function plan(overrides: Partial<SearchPlan> = {}): SearchPlan {
  return {
    industry: ['legal'],
    leadTypes: [],
    locations: [{ country: 'US', state: 'Florida' }],
    companyFields: [],
    unresolvedCriteria: [],
    ...overrides,
  };
}

describe('buildOverpassQuery', () => {
  it('builds a bounded node query from the category and geocoded window', () => {
    const query = buildOverpassQuery(plan(), { timeoutSeconds: 25, maxResults: 10, bbox });

    expect(query).toContain('[out:json][timeout:25];');
    expect(query).toContain('node["office"="lawyer"]["name"](25.700000,-80.300000,25.900000,-80.100000);');
    expect(query).toContain('out center 10;');
    expect(query).not.toContain('Texas');
  });

  it('reflects a different category without a fixed search', () => {
    const query = buildOverpassQuery(plan({
      industry: ['software'],
      locations: [{ country: 'US', state: 'California', city: 'San Jose' }],
    }), { timeoutSeconds: 20, maxResults: 5, bbox });

    expect(query).toContain('["office"="it"]');
    expect(query).not.toContain('["office"="lawyer"]');
    expect(query).toContain('out center 5;');
  });

  it('maps lead types independently from industry', () => {
    const query = buildOverpassQuery(plan({
      industry: [],
      leadTypes: ['real_estate_investor'],
      locations: [{ country: 'US', state: 'New York' }],
    }), { timeoutSeconds: 25, maxResults: 15, bbox });

    expect(query).toContain('["name"~"investor|investment|acquisition|holdings|buy and hold|fix and flip",i]');
    expect(query).toContain('["office"!="estate_agent"]');
    expect(query).not.toContain('["name"!~');
    expect(query).not.toContain('["office"="estate_agent"]');
    expect(query).not.toContain('["office"="property_management"]');
  });

  it('does not add brokerage selectors when an investor lead type is combined with real estate', () => {
    const query = buildOverpassQuery(plan({
      industry: ['real_estate'],
      leadTypes: ['real_estate_investor'],
    }), { timeoutSeconds: 25, maxResults: 50, bbox });

    expect(query).toContain('["name"~"investor|investment|acquisition|holdings|buy and hold|fix and flip",i]');
    expect(query).not.toContain('["office"="estate_agent"]');
    expect(query).not.toContain('["shop"="estate_agent"]');
    expect(query).toContain('out center 50;');
  });

  it('uses a name filter for an unrecognized category term', () => {
    const query = buildOverpassQuery(plan({
      industry: ['widget_makers'],
      locations: [{ country: 'DE' }],
    }), { timeoutSeconds: 25, maxResults: 8, bbox });

    expect(query).toContain('["name"~"widget makers",i]');
    expect(query).toContain('out center 8;');
  });

  it('rejects location values that could change a query', () => {
    expect(() => assertLocationText('Texas"; out;')).toThrow(/unsupported location value/);
  });

  it('does not build a query without a category or bbox', () => {
    expect(() => buildOverpassQuery(plan({ industry: [], leadTypes: [] }), { timeoutSeconds: 25, maxResults: 10, bbox })).toThrow(/requires a business category/);
    expect(() => buildOverpassQuery(plan(), { timeoutSeconds: 25, maxResults: 10, bbox: { south: 2, west: 2, north: 1, east: 3 } })).toThrow(/requires a location/);
  });

  it('caps the result limit and partitions a large area into bounded local windows', () => {
    const query = buildOverpassQuery(plan(), { timeoutSeconds: 25, maxResults: 500, bbox });
    expect(query).toContain('out center 100;');

    const parent = { south: 25.83706, west: -106.645846, north: 36.500453, east: -93.507822 };
    const windows = searchWindows(parent);
    expect(windows).toHaveLength(MAX_DISCOVERY_PARTITIONS);
    expect(windows.length).toBeGreaterThan(3);
    expect(Math.min(...windows.map((window) => window.south))).toBeCloseTo(parent.south, 6);
    expect(Math.max(...windows.map((window) => window.north))).toBeCloseTo(parent.north, 6);
    expect(Math.min(...windows.map((window) => window.west))).toBeCloseTo(parent.west, 6);
    expect(Math.max(...windows.map((window) => window.east))).toBeCloseTo(parent.east, 6);
    expect(windows.every((window) => window.north - window.south <= 4.01 && window.east - window.west <= 4.01)).toBe(true);
    const dallas = { lat: 32.9448189, lon: -97.1192319 };
    expect(windows.some((window) => dallas.lat >= window.south && dallas.lat <= window.north && dallas.lon >= window.west && dallas.lon <= window.east)).toBe(true);
    expect(searchWindows(bbox)).toEqual([bbox]);
  });

  it('keeps investor-name candidates and rejects brokerage, realtor, lender, and title companies', () => {
    expect(investorCandidateAllowed('Trinity Investments', 'company')).toBe(true);
    expect(investorCandidateAllowed('Oak Stream Investors', 'office')).toBe(true);
    expect(investorCandidateAllowed('Hill Country Brokerage', 'company')).toBe(false);
    expect(investorCandidateAllowed('Metro Realtor Group', 'estate agent')).toBe(false);
    expect(investorCandidateAllowed('Austin Realty Investments', 'estate agent')).toBe(false);
    expect(investorCandidateAllowed('Capital Mortgage Lender', 'financial')).toBe(false);
    expect(investorCandidateAllowed('Lone Star Title Company', 'company')).toBe(false);
    expect(investorCandidateAllowed('Premier Property Management', 'property management')).toBe(false);
    expect(investorCandidateAllowed('Texas Investment Directory', 'company')).toBe(false);
    expect(investorCandidateAllowed('Summit Holdings', 'insurance')).toBe(false);
  });

  it('keeps a Texas address and rejects a neighboring state without inventing a missing state', () => {
    expect(matchesRequestedState('Texas', 'TX')).toBe(true);
    expect(matchesRequestedState('Texas', 'Texas')).toBe(true);
    expect(matchesRequestedState('Texas', 'OK')).toBe(false);
    expect(matchesRequestedState('Texas', 'Oklahoma')).toBe(false);
    expect(matchesRequestedState('Texas', 'NM')).toBe(false);
    expect(matchesRequestedState('Texas', 'AR')).toBe(false);
    expect(matchesRequestedState('Texas', undefined)).toBe(true);
    expect(coordinateWithinRequestedState('Texas', 32.9448, -97.1192)).toBe(true);
    expect(coordinateWithinRequestedState('Texas', 31.76, -106.49)).toBe(true);
    expect(coordinateWithinRequestedState('Texas', 33.5829, -102.3673)).toBe(true);
    expect(coordinateWithinRequestedState('Texas', 36.0521, -95.7917)).toBe(false);
    expect(coordinateWithinRequestedState('Texas', 35.746, -95.4039)).toBe(false);
    expect(coordinateWithinRequestedState('Texas', 36.1198, -94.1409)).toBe(false);
    expect(coordinateWithinRequestedState('Texas', 35.6588, -105.9407)).toBe(false);
    expect(coordinateWithinRequestedState('Texas', 34.0271, -94.7381)).toBe(false);
    expect(coordinateWithinRequestedState('Texas', undefined, undefined)).toBe(true);
    expect(coordinateWithinRequestedState('Florida', 36.0521, -95.7917)).toBe(true);
  });

  it('leaves a missing employee count unknown for a requested 1-50 range', () => {
    expect(companySizeFit(null, null, { min: 1, max: 50 })).toBe('UNKNOWN');
    expect(companySizeFit(null, null, { min: 1, max: 50 })).not.toBe('MATCHED');
  });
});
