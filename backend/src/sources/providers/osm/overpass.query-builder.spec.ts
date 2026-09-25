import { SearchPlan } from '../../../search/types/search-plan.types';
import { assertLocationText, buildOverpassQuery, searchWindows } from './overpass.query-builder';

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

    expect(query).toContain('["name"~"investor|investments|acquisition",i]');
    expect(query).not.toContain('["office"="estate_agent"]');
    expect(query).not.toContain('["office"="property_management"]');
  });

  it('does not add brokerage selectors when an investor lead type is combined with real estate', () => {
    const query = buildOverpassQuery(plan({
      industry: ['real_estate'],
      leadTypes: ['real_estate_investor'],
    }), { timeoutSeconds: 25, maxResults: 50, bbox });

    expect(query).toContain('["name"~"investor|investments|acquisition",i]');
    expect(query).not.toContain('estate_agent');
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

  it('caps the result limit and splits a large area into one-degree windows', () => {
    const query = buildOverpassQuery(plan(), { timeoutSeconds: 25, maxResults: 500, bbox });
    expect(query).toContain('out center 100;');

    const parent = { south: 25.83706, west: -106.645846, north: 36.500453, east: -93.507822 };
    const windows = searchWindows(parent);
    expect(windows).toHaveLength(3);
    expect(windows[0].north).toBeLessThan(parent.north);
    expect(windows[0].east).toBeLessThan(parent.east);
    expect(windows[0].south).toBeGreaterThan(parent.south);
    expect(windows[0].west).toBeGreaterThan(parent.west);
    expect(windows.every((window) => window.south >= parent.south && window.north <= parent.north && window.west >= parent.west && window.east <= parent.east)).toBe(true);
    expect(windows.every((window) => Math.abs(window.north - window.south - 1) < 0.000001 && Math.abs(window.east - window.west - 1) < 0.000001)).toBe(true);
    expect(searchWindows(bbox)).toEqual([bbox]);
  });
});
