import { discoveryQueryBudget, discoveryTarget } from '../search/search-plan.limits';
import type { SearchPlan } from '../search/types/search-plan.types';
import { assessWebCompanyCandidate, collectWebCompanyCandidates, companyDiscoveryQueries, queryBudgetForPlan } from './providers/web-search/company-discovery.assess';
import { buildOverpassQuery, locationLabel } from './providers/osm/overpass.query-builder';
import { discoveryProviderFailure, resolveDiscoveryFallback } from './services/discovery-fallback';
import type { NormalizedSourceResult } from './types/source.types';
import type { WebSearchResult } from '../enrichment/website/web-search.types';

function plan(overrides: Partial<SearchPlan>): SearchPlan {
  return {
    industry: [],
    leadTypes: [],
    locations: [],
    companyFields: [],
    unresolvedCriteria: [],
    ...overrides,
  };
}

function hit(overrides: Partial<WebSearchResult> = {}): WebSearchResult {
  return {
    title: 'Acme Co | Home',
    url: 'https://acme.example/',
    snippet: 'Acme Co is a company.',
    source: 'web_search',
    retrievedAt: '2026-09-28T00:00:00.000Z',
    ...overrides,
  };
}

function company(name: string, website: string, city = 'Austin'): NormalizedSourceResult {
  return {
    externalId: `id:${website}`,
    name,
    website,
    sourceUrl: website,
    address: { city, state: 'Texas', country: 'US' },
  };
}

describe('Phase B SearchPlan-driven discovery', () => {
  it.each([
    ['Find 10 software companies in California', plan({ industry: ['software'], locations: [{ country: 'US', state: 'California' }], requestedCount: 10, maxResults: 10 }), 10],
    ['Find 50 restaurants in Dubai', plan({ industry: ['restaurant'], locations: [{ city: 'Dubai', country: 'United Arab Emirates' }], requestedCount: 50, maxResults: 50 }), 50],
    ['Find 100 construction companies in Germany', plan({ industry: ['construction'], locations: [{ country: 'Germany' }], requestedCount: 100, maxResults: 100 }), 100],
    ['Find 30 SaaS companies in Lahore', plan({ industry: ['saas'], locations: [{ city: 'Lahore', country: 'Pakistan' }], requestedCount: 30, maxResults: 30 }), 30],
    ['Find 200 real estate investors in Texas', plan({ industry: ['real_estate'], leadTypes: ['real_estate_investor'], locations: [{ country: 'US', state: 'Texas' }], requestedCount: 200, maxResults: 200 }), 200],
    ['Find 50 companies in London', plan({ locations: [{ city: 'London', country: 'United Kingdom' }], requestedCount: 50, maxResults: 50 }), 50],
  ])('uses requested count and place for %s', (_label, searchPlan, count) => {
    expect(discoveryTarget(searchPlan)).toBe(count);
    expect(queryBudgetForPlan(searchPlan, count)).toBe(discoveryQueryBudget(count));
    const queries = companyDiscoveryQueries(searchPlan, Math.min(8, queryBudgetForPlan(searchPlan, count)));
    expect(queries.length).toBeGreaterThan(0);
    const place = searchPlan.locations[0];
    const placeHint = [place?.city, place?.state, place?.region, place?.country, place?.originalText].filter(Boolean).join('|');
    expect(queries.some((query) => new RegExp(placeHint.split('|')[0]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(query))).toBe(true);
    if (!searchPlan.industry.includes('real_estate') && !searchPlan.leadTypes.includes('real_estate_investor')) {
      expect(queries.some((query) => /real estate investment company/i.test(query))).toBe(false);
    }
  });

  it('builds city+country and country-only queries from SearchPlan', () => {
    const cityCountry = companyDiscoveryQueries(plan({
      industry: ['software'],
      locations: [{ city: 'Lahore', country: 'Pakistan' }],
      requestedCount: 30,
    }), 4);
    expect(cityCountry[0]).toMatch(/software/i);
    expect(cityCountry[0]).toMatch(/Lahore/i);

    const countryOnly = companyDiscoveryQueries(plan({
      industry: ['construction'],
      locations: [{ country: 'Germany' }],
      requestedCount: 100,
    }), 6);
    expect(countryOnly.some((query) => /construction/i.test(query) && /Germany|Berlin|Munich|Hamburg/i.test(query))).toBe(true);
  });

  it('preserves unresolved originalText locations instead of inventing a default place', () => {
    const unresolved = plan({
      industry: ['software'],
      locations: [{ city: 'Bavaria', originalText: 'Bavaria', country: '' }],
      unresolvedRequirements: [{ text: 'Bavaria', reason: 'location could not be confidently resolved to a country or administrative area' }],
      requestedCount: 20,
    });
    expect(locationLabel(unresolved.locations[0])).toContain('Bavaria');
    const queries = companyDiscoveryQueries(unresolved, 3);
    expect(queries[0]).toMatch(/Bavaria/i);
    expect(queries.some((query) => /Texas|California/i.test(query))).toBe(false);
  });

  it('supports a dynamic industry outside the old hard-coded list', () => {
    const query = buildOverpassQuery(plan({
      industry: ['cybersecurity'],
      locations: [{ country: 'Pakistan' }],
      requestedCount: 25,
    }), { timeoutSeconds: 20, maxResults: 25, bbox: { south: 24, west: 66, north: 37, east: 77 } });
    expect(query).toContain('["name"~"cybersecurity",i]');
    expect(query).toContain('way["office"]');
    expect(query).toContain('relation["office"]');
    expect(query).not.toContain('Texas');
  });

  it.each([50, 300, 500])('scales the query budget for explicit count %s without inventing rows', async (count) => {
    const searchPlan = plan({
      industry: ['software'],
      locations: [{ country: 'US', state: 'California' }],
      requestedCount: count,
      maxResults: count,
    });
    expect(discoveryTarget(searchPlan)).toBe(count);
    expect(queryBudgetForPlan(searchPlan, count)).toBe(discoveryQueryBudget(count));
    expect(queryBudgetForPlan(searchPlan, count)).not.toBe(100);
    const collected = await collectWebCompanyCandidates(searchPlan, count, async () => [], { maxQueries: 3, delayMs: 0 });
    expect(collected.results).toEqual([]);
    expect(collected.results).not.toHaveLength(count);
  });

  it('keeps provider A successes when provider B fails and the reverse', () => {
    const alpha = company('Alpha Software', 'https://alpha.example', 'San Jose');
    const beta = company('Beta Soft', 'https://beta.example', 'Oakland');
    const aThenB = resolveDiscoveryFallback({
      primary: { results: [alpha], error: null },
      web: { results: [], error: 'Web search provider rate limit reached.' },
    });
    expect(aThenB.primary).toEqual([alpha]);
    expect(discoveryProviderFailure(1, 'osm', null, { error: 'Web search provider rate limit reached.' })).toBeNull();

    const bThenA = resolveDiscoveryFallback({
      primary: { results: [], error: 'OpenStreetMap provider rate limit reached.' },
      web: { results: [beta], error: null },
    });
    expect(bThenA.web).toEqual([beta]);
    expect(discoveryProviderFailure(1, 'osm', 'OpenStreetMap provider rate limit reached.', { error: null })).toBeNull();
  });

  it('reports a clear failure only when every available provider fails', () => {
    expect(discoveryProviderFailure(
      0,
      'osm',
      'OpenStreetMap discovery requires a business category.',
      { error: 'Web search provider is not configured.' },
    )).toMatch(/Discovery providers failed/);
  });

  it('deduplicates the same company discovered by two providers', () => {
    const osm = company('Oak Stream Investors', 'https://oakstream.example/');
    const web = company('Oak Stream Investors', 'https://oakstream.example/about');
    const resolved = resolveDiscoveryFallback({
      primary: { results: [osm], error: null },
      web: { results: [web], error: null },
    });
    expect(resolved.web).toEqual([]);
    expect(resolved.duplicatesRemoved).toBe(1);
  });

  it('returns a shortfall instead of fabricating candidates', async () => {
    const searchPlan = plan({
      industry: ['software'],
      locations: [{ country: 'US', state: 'California' }],
      requestedCount: 10,
      maxResults: 10,
    });
    const search = jest.fn().mockResolvedValue([hit({
      title: 'Northwind Software | Home',
      url: 'https://northwind.example/',
      snippet: 'Northwind Software builds developer tools in San Francisco, California.',
    })]);
    const collected = await collectWebCompanyCandidates(searchPlan, 10, search, { maxQueries: 4, delayMs: 0 });
    expect(collected.results).toHaveLength(1);
    expect(collected.results).not.toHaveLength(10);
  });

  it('rejects invalid, social, directory, and job-board candidates', () => {
    const searchPlan = plan({
      industry: ['software'],
      locations: [{ country: 'US', state: 'California' }],
      requestedCount: 10,
    });
    expect(assessWebCompanyCandidate(hit({
      title: 'Top 10 software companies in California',
      snippet: 'A list of software companies in California.',
    }), searchPlan).accepted).toBe(false);
    expect(assessWebCompanyCandidate(hit({ url: 'https://www.linkedin.com/company/acme' }), searchPlan)).toMatchObject({ accepted: false, reason: 'SOCIAL_PROFILE' });
    expect(assessWebCompanyCandidate(hit({ url: 'https://www.indeed.com/cmp/acme' }), searchPlan)).toMatchObject({ accepted: false, reason: 'JOB_BOARD' });
    expect(assessWebCompanyCandidate(hit({ url: 'https://www.rocketreach.co/acme' }), searchPlan)).toMatchObject({ accepted: false, reason: 'DIRECTORY' });
  });

  it('does not map generic investment wording to real-estate investors', () => {
    const investment = companyDiscoveryQueries(plan({
      industry: ['investment'],
      locations: [{ country: 'US', state: 'Texas' }],
      requestedCount: 20,
    }), 4);
    expect(investment.every((query) => /investment/i.test(query))).toBe(true);
    expect(investment.some((query) => /real estate investment company/i.test(query))).toBe(false);

    const investors = companyDiscoveryQueries(plan({
      industry: ['real_estate'],
      leadTypes: ['real_estate_investor'],
      locations: [{ country: 'US', state: 'Texas' }],
      requestedCount: 200,
    }), 4);
    expect(investors.some((query) => /real estate investment/i.test(query))).toBe(true);
  });

  it('keeps decision-maker roles on the plan without inventing contact data during discovery', () => {
    const searchPlan = plan({
      locations: [{ country: 'Pakistan' }],
      decisionMakerRoles: ['Founder', 'CEO'],
      requestedCount: 100,
      maxResults: 100,
    });
    const queries = companyDiscoveryQueries(searchPlan, 3);
    expect(queries[0]).toMatch(/company/i);
    expect(queries[0]).toMatch(/Pakistan|Lahore|Karachi/i);
    expect(queries.some((query) => /@|email|linkedin\.com\/in/i.test(query))).toBe(false);
  });
});
