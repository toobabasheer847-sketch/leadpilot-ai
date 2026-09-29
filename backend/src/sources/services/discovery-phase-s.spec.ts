import {
  discoveryAcceptanceCap,
  discoveryQueryBudget,
  discoveryTarget,
  resolveCountIntent,
} from '../../search/search-plan.limits';
import type { SearchPlan } from '../../search/types/search-plan.types';
import { buildGooglePlacesQueries } from '../providers/google-places/google-places.query-builder';
import {
  assessWebCompanyCandidate,
  collectWebCompanyCandidates,
  companyDiscoveryQueries,
  discoverySearchPlaces,
  expandDiscoveryQueryPlan,
  investorDiscoveryPhrases,
  queryBudgetForPlan,
} from '../providers/web-search/company-discovery.assess';
import type { WebSearchResult } from '../../enrichment/website/web-search.types';
import {
  buildExpandedDiscoveryQueries,
  expandDiscoveryLocationVariants,
  expandDiscoveryPhrases,
  normalizeQuerySignature,
  QueryFamilyYieldTracker,
} from './discovery-query-expansion';
import { DiscoveryExecutionCircuit } from './discovery-execution-circuit';
import { dedupeDiscoveryCandidates } from './discovery-fallback';
import { fillEmptyCompanyFields } from './company-field-merge';
import type { NormalizedSourceResult } from '../types/source.types';

function texas300Plan(overrides: Partial<SearchPlan> = {}): SearchPlan {
  return {
    industry: ['real_estate'],
    leadTypes: ['cash_home_buyer', 'fix_and_flip', 'wholesaler'],
    locations: [{ country: 'US', state: 'Texas' }],
    companyFields: [],
    unresolvedCriteria: [],
    requestedCount: 300,
    maxResults: 300,
    countIntent: 'exact',
    searchIntent: 'real estate investment companies specializing in cash home buyers, fix and flip, or wholesaling',
    exclusions: ['realtor', 'mortgage company', 'property management', 'attorney', 'photographer', 'software company', 'construction company'],
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

function company(name: string, website: string, extras: Partial<NormalizedSourceResult> = {}): NormalizedSourceResult {
  return {
    externalId: `id:${website}`,
    name,
    website,
    sourceUrl: website,
    address: { city: 'Austin', state: 'Texas', country: 'US' },
    category: 'real_estate_investor',
    ...extras,
  };
}

describe('Phase S discovery coverage & query expansion', () => {
  it('A. exact 300 Texas investor request preserves countIntent and caps', () => {
    const plan = texas300Plan();
    expect(resolveCountIntent(plan)).toBe('exact');
    expect(discoveryTarget(plan)).toBe(300);
    expect(discoveryAcceptanceCap(plan)).toBe(300);
    expect(discoveryQueryBudget(300)).toBe(600);
    expect(queryBudgetForPlan(plan, 300)).toBe(600);
  });

  it('B. query expansion generates bounded legitimate variants', () => {
    const plan = texas300Plan();
    const phrases = expandDiscoveryPhrases(plan);
    expect(phrases).toEqual(expect.arrayContaining([
      'real estate investor',
      'real estate investment company',
      'property investor',
      'cash home buyer',
      'cash buyer',
      'fix and flip',
      'house flipper',
      'real estate wholesaler',
      'property wholesaler',
    ]));
    expect(phrases.length).toBeLessThanOrEqual(16);
    expect(phrases.every((phrase) => !/realtor|mortgage|photographer|attorney|software company/i.test(phrase))).toBe(true);

    const expanded = buildExpandedDiscoveryQueries(plan, 80);
    expect(expanded.variants.length).toBeGreaterThan(20);
    expect(expanded.variants.length).toBeLessThanOrEqual(80);
    expect(expanded.metrics.queryFamiliesGenerated).toBeGreaterThan(5);
  });

  it('C. Texas remains the SearchPlan location', () => {
    const plan = texas300Plan();
    expandDiscoveryQueryPlan(plan, 40);
    buildGooglePlacesQueries(plan);
    expect(plan.locations).toEqual([{ country: 'US', state: 'Texas' }]);
    expect(plan.locations[0]?.city).toBeUndefined();
  });

  it('D. Houston/Dallas are provider query variants only', () => {
    const plan = texas300Plan();
    const locations = expandDiscoveryLocationVariants(plan);
    expect(locations.some((place) => /Houston/i.test(place))).toBe(true);
    expect(locations.some((place) => /Dallas/i.test(place))).toBe(true);
    expect(locations.some((place) => /Austin/i.test(place))).toBe(true);
    expect(plan.locations).toEqual([{ country: 'US', state: 'Texas' }]);

    const web = companyDiscoveryQueries(plan, 40);
    expect(web.some((query) => /Houston/i.test(query))).toBe(true);
    expect(web.some((query) => /Dallas/i.test(query))).toBe(true);
    expect(web.some((query) => /cash home buyer/i.test(query))).toBe(true);

    const places = buildGooglePlacesQueries(plan);
    expect(places.some((query) => /Houston/i.test(query) && /cash home buyer|fix and flip|wholesaler|investor/i.test(query))).toBe(true);
  });

  it('E. investor specialization remains preserved', () => {
    const plan = texas300Plan();
    const phrases = investorDiscoveryPhrases(plan);
    expect(phrases.some((phrase) => /cash home buyer/i.test(phrase))).toBe(true);
    expect(phrases.some((phrase) => /fix and flip/i.test(phrase))).toBe(true);
    expect(phrases.some((phrase) => /wholesaler/i.test(phrase))).toBe(true);
    const queries = companyDiscoveryQueries(plan, 30);
    expect(queries.some((query) => /cash home buyer/i.test(query))).toBe(true);
    expect(queries.some((query) => /fix and flip/i.test(query))).toBe(true);
    expect(queries.some((query) => /wholesaler/i.test(query))).toBe(true);
  });

  it('F. realtor/mortgage/property-management are not accepted from expansion hits', () => {
    const plan = texas300Plan();
    expect(assessWebCompanyCandidate(hit({
      title: 'Texas Premier Realtors | Home',
      url: 'https://txrealtors.example/',
      snippet: 'Licensed realtor helping families buy homes in Houston, Texas.',
    }), plan).accepted).toBe(false);
    expect(assessWebCompanyCandidate(hit({
      title: 'Lone Star Mortgage Co | Home',
      url: 'https://lonestarmortgage.example/',
      snippet: 'Mortgage company serving Texas home buyers.',
    }), plan).accepted).toBe(false);
    expect(assessWebCompanyCandidate(hit({
      title: 'Austin Property Management | Home',
      url: 'https://austinpm.example/',
      snippet: 'Property management company for rental owners in Austin, Texas.',
    }), plan).accepted).toBe(false);
    expect(assessWebCompanyCandidate(hit(), plan).accepted).toBe(true);
  });

  it('G. duplicate queries are skipped via normalized signatures', () => {
    const plan = texas300Plan();
    const a = normalizeQuerySignature('Cash Home Buyer  Houston,  Texas');
    const b = normalizeQuerySignature('cash home buyer houston texas');
    expect(a).toBe(b);
    const expanded = buildExpandedDiscoveryQueries(plan, 200);
    const signatures = expanded.variants.map((variant) => variant.signature);
    expect(new Set(signatures).size).toBe(signatures.length);
    expect(expanded.metrics.duplicateQueriesSkipped).toBeGreaterThanOrEqual(0);
  });

  it('H/I. duplicate companies across providers merge fields but count once', () => {
    const primary = company('Oak Stream Investors', 'https://oakstream.example/', { phone: undefined });
    const secondary = company('Oak Stream Investors', 'https://oakstream.example/', {
      phone: '+1 512 555 0100',
      address: { city: 'Austin', state: 'Texas', country: 'US', addressLine1: '100 Congress Ave' },
    });
    const deduped = dedupeDiscoveryCandidates([primary], [secondary]);
    expect(deduped.accepted).toHaveLength(0);
    expect(deduped.duplicatesRemoved).toBe(1);
    expect(deduped.supplements).toHaveLength(1);
    expect(fillEmptyCompanyFields(
      { website: primary.website, phone: null, email: null, category: null, googlePlaceId: null },
      { website: secondary.website, phone: secondary.phone, email: null, category: secondary.category, googlePlaceId: null },
    )).toEqual({ phone: '+1 512 555 0100', category: 'real_estate_investor' });
  });

  it('J. acceptance stops at 300', async () => {
    let calls = 0;
    const search = jest.fn().mockImplementation(async () => {
      calls += 1;
      return [hit({
        title: `Investor ${calls} | Home`,
        url: `https://investor-${calls}.example/`,
        snippet: `Real estate investment company in Dallas, Texas specializing in cash home buying.`,
      })];
    });
    const collected = await collectWebCompanyCandidates(texas300Plan(), 300, search, {
      maxQueries: 320,
      delayMs: 0,
      concurrency: 4,
    });
    expect(collected.results.length).toBeLessThanOrEqual(300);
    expect(search.mock.calls.length).toBeLessThanOrEqual(320);
  });

  it('K. provider budget stops further querying', async () => {
    const search = jest.fn().mockResolvedValue([hit()]);
    await collectWebCompanyCandidates(texas300Plan(), 300, search, { maxQueries: 5, delayMs: 0, concurrency: 1 });
    expect(search).toHaveBeenCalledTimes(5);
  });

  it('L/M. circuit breaker stops a failed provider while others can continue', () => {
    const circuit = new DiscoveryExecutionCircuit('exec-s', 'org-s');
    expect(circuit.trip('web_search', 'QUOTA_EXCEEDED', 'Web search provider plan limit exceeded.')).toBe(true);
    expect(circuit.isUnavailable('web_search')).toBe(true);
    expect(circuit.isUnavailable('google_places')).toBe(false);
    expect(circuit.isUnavailable('osm')).toBe(false);
  });

  it('N/O. honest shortfall with no fabricated fill', async () => {
    const search = jest.fn()
      .mockResolvedValueOnce([hit()])
      .mockResolvedValue([]);
    const collected = await collectWebCompanyCandidates(texas300Plan(), 300, search, {
      maxQueries: 12,
      delayMs: 0,
      concurrency: 1,
    });
    expect(collected.results.length).toBe(1);
    expect(collected.results).not.toHaveLength(300);
    expect(300 - collected.results.length).toBe(299);
  });

  it('P. organization isolation for yield tracker / circuit scope', () => {
    const a = new DiscoveryExecutionCircuit('exec-1', 'org-a');
    const b = new DiscoveryExecutionCircuit('exec-1', 'org-b');
    a.trip('osm', 'LOCATION_RESOLUTION_FAILED', 'unresolved');
    expect(a.isUnavailable('osm')).toBe(true);
    expect(b.isUnavailable('osm')).toBe(false);

    const tracker = new QueryFamilyYieldTracker();
    tracker.record('cash home buyer|houston texas', { raw: 3, acceptedNew: 0, duplicates: 3, rejected: 0 });
    tracker.record('cash home buyer|houston texas', { raw: 2, acceptedNew: 0, duplicates: 2, rejected: 0 });
    tracker.record('cash home buyer|houston texas', { raw: 1, acceptedNew: 0, duplicates: 1, rejected: 0 });
    expect(tracker.shouldSkip('cash home buyer|houston texas')).toBe(true);
    expect(tracker.shouldSkip('cash home buyer|dallas texas')).toBe(false);
  });

  it('exposes Phase S expansion metrics from web collection', async () => {
    const search = jest.fn().mockResolvedValue([]);
    const collected = await collectWebCompanyCandidates(texas300Plan(), 10, search, {
      maxQueries: 15,
      delayMs: 0,
      concurrency: 3,
    });
    expect(collected.queriesGenerated).toBeGreaterThan(0);
    expect(collected.queryFamiliesGenerated).toBeGreaterThan(0);
    expect(collected.queriesRun).toBeLessThanOrEqual(15);
    expect(typeof collected.queriesSkippedDuplicate).toBe('number');
    expect(typeof collected.queriesSkippedBudget).toBe('number');
  });

  it('does not expand into excluded unrelated categories', () => {
    const phrases = expandDiscoveryPhrases(texas300Plan());
    expect(phrases.join(' ')).not.toMatch(/\brealtor\b|\bmortgage\b|\bproperty management\b|\battorney\b|\bphotographer\b|\bsoftware company\b/i);
    const places = discoverySearchPlaces(texas300Plan());
    expect(places.every((place) => /Texas/i.test(place))).toBe(true);
  });
});
