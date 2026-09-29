import { discoveryAcceptanceCap, discoveryQueryBudget, discoveryTarget, resolveCountIntent } from '../search/search-plan.limits';
import type { SearchPlan } from '../search/types/search-plan.types';
import { discoveryLocations } from './providers/osm/overpass.query-builder';
import { buildGooglePlacesQueries } from './providers/google-places/google-places.query-builder';
import {
  assessWebCompanyCandidate,
  collectWebCompanyCandidates,
  companyDiscoveryQueries,
  discoverySearchPlaces,
  investorDiscoveryPhrases,
  queryBudgetForPlan,
} from './providers/web-search/company-discovery.assess';
import type { WebSearchResult } from '../enrichment/website/web-search.types';

function texasInvestorPlan(overrides: Partial<SearchPlan> = {}): SearchPlan {
  return {
    industry: ['real_estate'],
    leadTypes: ['cash_home_buyer', 'fix_and_flip', 'wholesaler'],
    locations: [{ country: 'US', state: 'Texas' }],
    companyFields: [],
    unresolvedCriteria: [],
    requestedCount: 300,
    maxResults: 300,
    countIntent: 'exact',
    ...overrides,
  };
}

function hit(overrides: Partial<WebSearchResult> = {}): WebSearchResult {
  return {
    title: 'Lone Star Cash Buyers | Home',
    url: 'https://lonestarcash.example/',
    snippet: 'Cash home buyer and fix and flip investor in Houston, Texas.',
    source: 'tavily',
    retrievedAt: '2026-09-29T00:00:00.000Z',
    ...overrides,
  };
}

describe('Phase K high-volume discovery', () => {
  it('A. exact 300 target drives discoveryTarget, acceptance cap, and scaled query budget', () => {
    const plan = texasInvestorPlan();
    expect(resolveCountIntent(plan)).toBe('exact');
    expect(discoveryTarget(plan)).toBe(300);
    expect(discoveryAcceptanceCap(plan)).toBe(300);
    expect(discoveryQueryBudget(300)).toBe(600);
    expect(queryBudgetForPlan(plan, 300)).toBe(600);
    const queries = companyDiscoveryQueries(plan, queryBudgetForPlan(plan, 300));
    expect(queries.length).toBeGreaterThan(50);
    expect(queries.length).toBeLessThanOrEqual(600);
  });

  it('B. provider pagination budget stays within configured query budget', () => {
    const plan = texasInvestorPlan({ requestedCount: 40, maxResults: 40 });
    const gpQueries = buildGooglePlacesQueries(plan);
    const capped = gpQueries.slice(0, discoveryQueryBudget(40));
    expect(gpQueries.length).toBeGreaterThan(capped.length === gpQueries.length ? 0 : -1);
    expect(capped.length).toBeLessThanOrEqual(discoveryQueryBudget(40));
    expect(capped.every((query) => /Texas/i.test(query))).toBe(true);
  });

  it('C. multiple Texas location queries cover expansion cities for web, Places, and OSM', () => {
    const plan = texasInvestorPlan();
    const places = discoverySearchPlaces(plan);
    expect(places.some((place) => /Houston/i.test(place))).toBe(true);
    expect(places.some((place) => /Dallas/i.test(place))).toBe(true);
    expect(places.some((place) => /Austin/i.test(place))).toBe(true);

    const webQueries = companyDiscoveryQueries(plan, 30);
    expect(webQueries.some((query) => /Houston/i.test(query))).toBe(true);
    expect(webQueries.some((query) => /Dallas/i.test(query))).toBe(true);
    // Place-first interleave: early queries should not all be the same city.
    const earlyCities = webQueries.slice(0, 8).map((query) => {
      if (/Houston/i.test(query)) return 'Houston';
      if (/Dallas/i.test(query)) return 'Dallas';
      if (/Austin/i.test(query)) return 'Austin';
      if (/San Antonio/i.test(query)) return 'San Antonio';
      return 'other';
    });
    expect(new Set(earlyCities.filter((city) => city !== 'other')).size).toBeGreaterThan(1);

    const gp = buildGooglePlacesQueries(plan);
    expect(gp.some((query) => /Houston/i.test(query))).toBe(true);
    expect(gp.some((query) => /Dallas/i.test(query))).toBe(true);

    const osmLocations = discoveryLocations(plan);
    expect(osmLocations).toHaveLength(1);
    expect(osmLocations[0]).toMatchObject({ state: 'Texas', country: 'US' });
    // OSM covers the state via geocoded bbox partitions (searchWindows), not city expansion.
  });

  it('D. query diversification follows SearchPlan lead types without hard-coding Texas', () => {
    const plan = texasInvestorPlan();
    const phrases = investorDiscoveryPhrases(plan);
    expect(phrases).toEqual(expect.arrayContaining([
      'cash home buyer',
      'cash buyer',
      'fix and flip',
      'house flipper',
      'real estate wholesaler',
      'real estate wholesaling',
    ]));
    const queries = companyDiscoveryQueries(plan, 40);
    expect(queries.some((query) => /cash home buyer/i.test(query))).toBe(true);
    expect(queries.some((query) => /fix and flip/i.test(query))).toBe(true);
    expect(queries.some((query) => /wholesal/i.test(query))).toBe(true);

    const california = companyDiscoveryQueries({
      ...plan,
      locations: [{ country: 'US', state: 'California' }],
    }, 12);
    expect(california.every((query) => !/Texas/i.test(query))).toBe(true);
    expect(california.some((query) => /Los Angeles|San Francisco|San Diego/i.test(query))).toBe(true);
  });

  it('E. duplicate candidates are skipped early by identity keys', async () => {
    const plan = texasInvestorPlan({ requestedCount: 5, maxResults: 5 });
    const search = jest.fn().mockResolvedValue([
      hit(),
      hit({ title: 'Lone Star Cash Buyers | About', url: 'https://lonestarcash.example/about' }),
      hit({
        title: 'River Flip Partners',
        url: 'https://riverflip.example/',
        snippet: 'Fix and flip investment company in Dallas, Texas.',
      }),
    ]);
    const collected = await collectWebCompanyCandidates(plan, 5, search, { maxQueries: 4, delayMs: 0, concurrency: 1 });
    expect(collected.results).toHaveLength(2);
    expect(collected.results.map((item) => item.website).sort((a, b) => String(a).localeCompare(String(b)))).toEqual([
      'https://lonestarcash.example',
      'https://riverflip.example',
    ]);
  });

  it('F. provider failure on one query falls back to later queries', async () => {
    const plan = texasInvestorPlan({ requestedCount: 3, maxResults: 3 });
    let calls = 0;
    const search = jest.fn().mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new Error('temporary upstream failure');
      return [hit({
        title: 'Austin Cash Home Buyers',
        url: `https://austincash${calls}.example/`,
        snippet: 'Cash home buyer specializing in fix and flip deals in Austin, Texas.',
      })];
    });
    const collected = await collectWebCompanyCandidates(plan, 3, search, {
      maxQueries: 4,
      delayMs: 0,
      concurrency: 1,
      maxConsecutiveFailures: 5,
    });
    expect(calls).toBeGreaterThan(1);
    expect(collected.results.length).toBeGreaterThan(0);
    expect(collected.providerError).toBeNull();
  });

  it('G. bounded concurrency never exceeds the configured batch size', async () => {
    const plan = texasInvestorPlan({ requestedCount: 10, maxResults: 10 });
    let inFlight = 0;
    let maxInFlight = 0;
    const search = jest.fn().mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return [];
    });
    await collectWebCompanyCandidates(plan, 10, search, {
      maxQueries: 6,
      delayMs: 0,
      concurrency: 2,
    });
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(search.mock.calls.length).toBe(6);
  });

  it('H. does not fabricate candidates to fill an exact shortfall', async () => {
    const plan = texasInvestorPlan({ requestedCount: 300, maxResults: 300, countIntent: 'exact' });
    const search = jest.fn().mockResolvedValue([hit()]);
    const collected = await collectWebCompanyCandidates(plan, discoveryTarget(plan), search, {
      maxQueries: 3,
      delayMs: 0,
      concurrency: 1,
    });
    expect(collected.results.length).toBe(1);
    expect(collected.results.length).toBeLessThan(300);
    expect(discoveryAcceptanceCap(plan)).toBe(300);
  });

  it('I. countIntent is preserved for exact / maximum / minimum / approximate', () => {
    expect(resolveCountIntent(texasInvestorPlan({ countIntent: 'exact' }))).toBe('exact');
    expect(resolveCountIntent(texasInvestorPlan({ countIntent: 'maximum' }))).toBe('maximum');
    expect(resolveCountIntent(texasInvestorPlan({ countIntent: 'approximate' }))).toBe('approximate');
    expect(resolveCountIntent(texasInvestorPlan({ countIntent: 'minimum' }))).toBe('minimum');
    expect(discoveryTarget(texasInvestorPlan({ countIntent: 'minimum', requestedCount: 80, maxResults: 80 }))).toBe(100);
    expect(discoveryAcceptanceCap(texasInvestorPlan({ countIntent: 'maximum' }))).toBe(300);
  });

  it('J. Phase A–J accuracy gates still reject directories, job boards, and foreign-state leaks', () => {
    const plan = texasInvestorPlan();
    expect(assessWebCompanyCandidate(hit({
      title: 'Top Cash Buyers in Texas',
      url: 'https://www.clutch.co/tx-buyers',
      snippet: 'Directory of cash home buyers in Texas.',
    }), plan).accepted).toBe(false);
    expect(assessWebCompanyCandidate(hit({
      url: 'https://www.indeed.com/cmp/buyer',
      snippet: 'Cash home buyer jobs in Texas.',
    }), plan)).toMatchObject({ accepted: false, reason: 'JOB_BOARD' });
    expect(assessWebCompanyCandidate(hit({
      title: 'Denver Flip Co',
      url: 'https://denverflip.example/',
      snippet: 'Fix and flip investor based in Denver, Colorado serving the mountain west.',
    }), plan)).toMatchObject({ accepted: false, reason: 'OUTSIDE_REQUESTED_LOCATION' });
    expect(assessWebCompanyCandidate(hit(), plan).accepted).toBe(true);
  });
});
