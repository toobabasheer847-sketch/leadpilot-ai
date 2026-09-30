import {
  discoveryAcceptanceCap,
  discoveryQueryBudget,
  discoveryTarget,
  resolveCountIntent,
} from '../../search/search-plan.limits';
import type { SearchPlan } from '../../search/types/search-plan.types';
import type { WebSearchResult } from '../../enrichment/website/web-search.types';
import {
  assessWebCompanyCandidate,
  collectWebCompanyCandidates,
  companyDiscoveryQueries,
  expandDiscoveryQueryPlan,
  investorDiscoveryPhrases,
} from '../providers/web-search/company-discovery.assess';
import { DiscoveryExecutionCircuit } from './discovery-execution-circuit';
import { dedupeDiscoveryCandidates } from './discovery-fallback';
import { fillEmptyCompanyFields } from './company-field-merge';
import {
  buildExpandedDiscoveryQueries,
  expandDiscoveryLocationVariants,
  expandDiscoveryPhrases,
  type DiscoveryQueryVariant,
} from './discovery-query-expansion';
import {
  classifyDiscoveryRejectionReason,
  DiscoveryYieldTracker,
} from './discovery-yield';
import { discoveryProgressSummary, type DiscoveryProviderAttempt } from './discovery-provider-outcome';
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
    exclusions: [
      'realtor',
      'mortgage company',
      'property management',
      'attorney',
      'photographer',
      'software company',
      'construction company',
    ],
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

function variant(familyId: string, categoryPhrase: string, locationVariant: string, query?: string): DiscoveryQueryVariant {
  return {
    familyId,
    categoryPhrase,
    locationVariant,
    query: query ?? `${categoryPhrase} ${locationVariant}`,
    signature: `${categoryPhrase} ${locationVariant}`.toLowerCase(),
  };
}

describe('Phase T discovery yield / quality observability', () => {
  it('A. high-yield query family receives remaining budget', () => {
    const plan = texas300Plan();
    const tracker = new DiscoveryYieldTracker(plan);
    const productive = variant('cash home buyer|houston texas', 'cash home buyer', 'Houston Texas');
    const noisy = variant('property investor|dallas texas', 'property investor', 'Dallas Texas');
    tracker.recordIssued(productive);
    tracker.recordBatch(productive, { raw: 2, newlyAccepted: 2, duplicates: 0, rejected: 0 });
    tracker.recordIssued(noisy);
    tracker.recordBatch(noisy, { raw: 20, newlyAccepted: 0, duplicates: 0, rejected: 20 });

    const remaining = [
      variant('property investor|austin texas', 'property investor', 'Austin Texas'),
      variant('cash home buyer|dallas texas', 'cash home buyer', 'Dallas Texas'),
      variant('property investor|san antonio texas', 'property investor', 'San Antonio Texas'),
    ];
    const ordered = tracker.prioritizeVariants(remaining);
    expect(ordered[0]?.categoryPhrase).toBe('cash home buyer');
    expect(tracker.priorityScore(productive.familyId)).toBeGreaterThan(tracker.priorityScore(noisy.familyId));
  });

  it('B. duplicate-heavy family loses priority', () => {
    const plan = texas300Plan();
    const tracker = new DiscoveryYieldTracker(plan);
    const dupHeavy = variant('fix and flip|houston texas', 'fix and flip', 'Houston Texas');
    const clean = variant('wholesaler|dallas texas', 'wholesaler', 'Dallas Texas');
    tracker.recordIssued(dupHeavy);
    tracker.recordBatch(dupHeavy, { raw: 12, newlyAccepted: 1, duplicates: 10, rejected: 1 });
    tracker.recordIssued(clean);
    tracker.recordBatch(clean, { raw: 2, newlyAccepted: 1, duplicates: 0, rejected: 1 });
    expect(tracker.priorityScore(clean.familyId)).toBeGreaterThan(tracker.priorityScore(dupHeavy.familyId));
  });

  it('C. zero-yield family is eventually skipped', () => {
    const plan = texas300Plan();
    const tracker = new DiscoveryYieldTracker(plan);
    // Non-required expansion phrase so low-yield skip is allowed.
    const family = variant('residential investor|el paso texas', 'residential investor', 'El Paso Texas');
    for (let i = 0; i < 3; i += 1) {
      tracker.recordIssued(family);
      tracker.recordBatch(family, { raw: 5, newlyAccepted: 0, duplicates: 0, rejected: 5 });
    }
    expect(tracker.shouldSkip(family.familyId)).toBe(true);
  });

  it('D. explicitly required query family is not silently removed', () => {
    const plan = texas300Plan();
    const tracker = new DiscoveryYieldTracker(plan);
    const required = variant('cash home buyer|houston texas', 'cash home buyer', 'Houston Texas');
    for (let i = 0; i < 5; i += 1) {
      tracker.recordIssued(required);
      tracker.recordBatch(required, { raw: 4, newlyAccepted: 0, duplicates: 0, rejected: 4 });
    }
    expect(tracker.ensureFamily(required).required).toBe(true);
    expect(tracker.shouldSkip(required.familyId)).toBe(false);
  });

  it('E. WRONG_LOCATION rejection is tracked', async () => {
    const plan = texas300Plan();
    const search = jest.fn().mockResolvedValue([hit({
      title: 'Oregon Cash Homes | Home',
      url: 'https://oregoncash.example/',
      snippet: 'Cash home buyer serving Portland, Oregon.',
    })]);
    const collected = await collectWebCompanyCandidates(plan, 5, search, {
      maxQueries: 3,
      delayMs: 0,
      concurrency: 1,
    });
    expect(collected.results).toHaveLength(0);
    expect(collected.rejectionCounts?.WRONG_LOCATION ?? 0).toBeGreaterThan(0);
    expect(classifyDiscoveryRejectionReason('OUTSIDE_REQUESTED_LOCATION')).toBe('WRONG_LOCATION');
  });

  it('F. WRONG_CATEGORY rejection is tracked', async () => {
    const plan = texas300Plan();
    const decision = assessWebCompanyCandidate(hit({
      title: 'Austin Dentist Group | Home',
      url: 'https://austindentist.example/',
      snippet: 'Family dentist clinic in Austin, Texas.',
    }), plan);
    expect(decision.accepted).toBe(false);
    if (!decision.accepted) {
      expect(classifyDiscoveryRejectionReason(decision.reason)).toBe('WRONG_CATEGORY');
    }

    const search = jest.fn().mockResolvedValue([hit({
      title: 'Austin Dentist Group | Home',
      url: 'https://austindentist.example/',
      snippet: 'Family dentist clinic in Austin, Texas.',
    })]);
    const collected = await collectWebCompanyCandidates(plan, 5, search, {
      maxQueries: 2,
      delayMs: 0,
      concurrency: 1,
    });
    expect(collected.rejectionCounts?.WRONG_CATEGORY ?? 0).toBeGreaterThan(0);
  });

  it('G. excluded category is tracked', async () => {
    const plan = texas300Plan();
    const realtorHit = hit({
      title: 'Texas Premier Realtors | Home',
      url: 'https://txrealtors.example/',
      snippet: 'Real estate investment company and licensed realtor helping cash home buyers in Houston, Texas.',
    });
    const decision = assessWebCompanyCandidate(realtorHit, plan);
    expect(decision.accepted).toBe(false);
    if (!decision.accepted) {
      expect(decision.reason).toBe('EXCLUSION_MATCH');
      expect(classifyDiscoveryRejectionReason(decision.reason)).toBe('EXCLUDED_CATEGORY');
    }

    const search = jest.fn().mockResolvedValue([realtorHit]);
    const collected = await collectWebCompanyCandidates(plan, 5, search, {
      maxQueries: 2,
      delayMs: 0,
      concurrency: 1,
    });
    expect(collected.rejectionCounts?.EXCLUDED_CATEGORY ?? 0).toBeGreaterThan(0);
  });

  it('H. provider quota is tracked', async () => {
    const search = jest.fn().mockRejectedValue(new Error('Web search provider plan limit exceeded.'));
    const collected = await collectWebCompanyCandidates(texas300Plan(), 10, search, {
      maxQueries: 4,
      delayMs: 0,
      concurrency: 1,
      maxConsecutiveFailures: 1,
    });
    expect(collected.stopReason).toBe('PROVIDER_QUOTA');
    expect(collected.rejectionCounts?.PROVIDER_QUOTA ?? 0).toBeGreaterThan(0);
    expect(classifyDiscoveryRejectionReason('pay-as-you-go limit exceeded')).toBe('PROVIDER_QUOTA');
  });

  it('I. provider rate limit is tracked', async () => {
    const search = jest.fn().mockRejectedValue(new Error('HTTP 429 rate limit from provider'));
    const collected = await collectWebCompanyCandidates(texas300Plan(), 10, search, {
      maxQueries: 4,
      delayMs: 0,
      concurrency: 1,
      maxConsecutiveFailures: 1,
    });
    expect(collected.stopReason).toBe('PROVIDER_RATE_LIMIT');
    expect(collected.rejectionCounts?.PROVIDER_RATE_LIMIT ?? 0).toBeGreaterThan(0);
  });

  it('J. provider contribution metrics are correct', () => {
    const attempts: DiscoveryProviderAttempt[] = [
      {
        provider: 'google_places',
        outcome: 'SUCCESS',
        message: null,
        resultsCount: 40,
        acceptedCandidates: 40,
        duplicatesRemoved: 5,
        queriesRun: 20,
        queriesSkipped: 0,
      },
      {
        provider: 'osm',
        outcome: 'QUOTA_EXCEEDED',
        message: 'quota',
        resultsCount: 0,
        acceptedCandidates: 0,
        duplicatesRemoved: 0,
        queriesRun: 2,
        queriesSkipped: 100,
        errorCategory: 'QUOTA_EXCEEDED',
      },
      {
        provider: 'web_search',
        outcome: 'SUCCESS',
        message: null,
        resultsCount: 47,
        acceptedCandidates: 47,
        duplicatesRemoved: 12,
        queriesRun: 80,
        queriesSkipped: 10,
      },
    ];
    const summary = discoveryProgressSummary(attempts);
    expect(summary.acceptedCandidates).toBe(87);
    expect(summary.duplicatesRemoved).toBe(17);
    expect(summary.queriesAttempted).toBe(102);
    expect(summary.providersQuotaExceeded).toBe(1);
    expect(summary.providersSucceeded).toBe(2);
    expect(attempts.reduce((sum, row) => sum + (row.acceptedCandidates ?? 0), 0)).toBe(87);
  });

  it('K. location variant metrics do not alter SearchPlan location', async () => {
    const plan = texas300Plan();
    const locationsBefore = structuredClone(plan.locations);
    const variants = expandDiscoveryLocationVariants(plan);
    expect(variants.some((place) => /Houston/i.test(place))).toBe(true);
    expect(variants.some((place) => /Dallas/i.test(place))).toBe(true);

    const search = jest.fn().mockImplementation(async (query: string) => {
      if (/Houston/i.test(query)) {
        return [hit({
          title: 'Houston Cash Co | Home',
          url: 'https://houstoncash.example/',
          snippet: 'Cash home buyer in Houston, Texas.',
        })];
      }
      return [];
    });
    const collected = await collectWebCompanyCandidates(plan, 5, search, {
      maxQueries: 12,
      delayMs: 0,
      concurrency: 2,
    });
    expect(plan.locations).toEqual(locationsBefore);
    expect(plan.locations[0]?.state).toBe('Texas');
    expect(plan.locations[0]?.city).toBeUndefined();
    expect(collected.locationYieldSummary ?? '').toMatch(/Houston/i);
  });

  it('L. category semantics remain unchanged', () => {
    const plan = texas300Plan();
    const phrases = expandDiscoveryPhrases(plan);
    expect(phrases.join(' ')).not.toMatch(
      /\brealtor\b|\bmortgage\b|\bproperty management\b|\battorney\b|\bphotographer\b|\bsoftware\b|\bconstruction\b/i,
    );
    const investor = investorDiscoveryPhrases(plan);
    expect(investor.some((phrase) => /cash home buyer/i.test(phrase))).toBe(true);
    expect(investor.some((phrase) => /fix and flip/i.test(phrase))).toBe(true);
    expect(investor.some((phrase) => /wholesaler/i.test(phrase))).toBe(true);
    expandDiscoveryQueryPlan(plan, 40);
    expect(plan.leadTypes).toEqual(['cash_home_buyer', 'fix_and_flip', 'wholesaler']);
    expect(plan.exclusions).toEqual(expect.arrayContaining(['realtor', 'mortgage company']));
  });

  it('M. 300-company request respects acceptanceCap', async () => {
    const plan = texas300Plan();
    expect(resolveCountIntent(plan)).toBe('exact');
    expect(discoveryTarget(plan)).toBe(300);
    expect(discoveryAcceptanceCap(plan)).toBe(300);
    expect(discoveryQueryBudget(300)).toBe(600);

    let n = 0;
    const search = jest.fn().mockImplementation(async () => {
      n += 1;
      return [hit({
        title: `TX Investor ${n} | Home`,
        url: `https://tx-investor-${n}.example/`,
        snippet: `Cash home buyer and real estate investment company in Dallas, Texas.`,
      })];
    });
    const collected = await collectWebCompanyCandidates(plan, 300, search, {
      maxQueries: 320,
      delayMs: 0,
      concurrency: 4,
    });
    expect(collected.results.length).toBeLessThanOrEqual(300);
    expect(collected.stopReason === 'ACCEPTANCE_CAP_REACHED' || collected.results.length < 300).toBe(true);
  });

  it('N. no fabricated companies', async () => {
    const search = jest.fn()
      .mockResolvedValueOnce([hit()])
      .mockResolvedValue([]);
    const collected = await collectWebCompanyCandidates(texas300Plan(), 300, search, {
      maxQueries: 10,
      delayMs: 0,
      concurrency: 1,
    });
    expect(collected.results).toHaveLength(1);
    expect(300 - collected.results.length).toBe(299);
    expect(collected.results.every((row) => Boolean(row.website || row.sourceUrl))).toBe(true);
  });

  it('O. cross-provider duplicates enrich empty fields but do not increase accepted count', () => {
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
      {
        website: secondary.website,
        phone: secondary.phone,
        email: null,
        category: secondary.category,
        googlePlaceId: null,
      },
    )).toEqual({ phone: '+1 512 555 0100', category: 'real_estate_investor' });
  });

  it('P. organization isolation remains intact', () => {
    const a = new DiscoveryExecutionCircuit('exec-t', 'org-a');
    const b = new DiscoveryExecutionCircuit('exec-t', 'org-b');
    a.trip('web_search', 'QUOTA_EXCEEDED', 'quota');
    expect(a.isUnavailable('web_search')).toBe(true);
    expect(b.isUnavailable('web_search')).toBe(false);
  });

  it('Q. circuit breaker remains intact', () => {
    const circuit = new DiscoveryExecutionCircuit('exec-t-q', 'org-t');
    expect(circuit.trip('osm', 'RATE_LIMITED', '429')).toBe(true);
    expect(circuit.isUnavailable('osm')).toBe(true);
    expect(circuit.isUnavailable('google_places')).toBe(false);
    expect(circuit.isUnavailable('web_search')).toBe(false);
  });

  it('R. bounded concurrency remains intact', async () => {
    let inflight = 0;
    let maxInflight = 0;
    const search = jest.fn().mockImplementation(async () => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      await Promise.resolve();
      inflight -= 1;
      return [];
    });
    await collectWebCompanyCandidates(texas300Plan(), 20, search, {
      maxQueries: 12,
      delayMs: 0,
      concurrency: 3,
    });
    expect(maxInflight).toBeLessThanOrEqual(3);
    expect(search.mock.calls.length).toBeLessThanOrEqual(12);
  });

  it('S. existing Phase K–S behavior remains regression-safe', () => {
    const plan = texas300Plan();
    expect(resolveCountIntent(plan)).toBe('exact');
    expect(discoveryAcceptanceCap(plan)).toBe(300);
    const expanded = buildExpandedDiscoveryQueries(plan, 40);
    expect(expanded.variants.length).toBeGreaterThan(10);
    expect(expanded.variants.length).toBeLessThanOrEqual(40);
    expect(plan.locations).toEqual([{ country: 'US', state: 'Texas' }]);
    const queries = companyDiscoveryQueries(plan, 20);
    expect(queries.some((query) => /Houston|Dallas|Austin|Texas/i.test(query))).toBe(true);
    expect(queries.every((query) => !/realtor|mortgage company|photographer/i.test(query))).toBe(true);
    expect(classifyDiscoveryRejectionReason('GENERIC_LIST')).toBe('DIRECTORY_OR_LISTICLE');
    expect(classifyDiscoveryRejectionReason('INVALID_URL')).toBe('INVALID_COMPANY_IDENTITY');
  });

  it('exposes Phase T yield snapshot fields from web collection', async () => {
    const search = jest.fn().mockResolvedValue([hit()]);
    const collected = await collectWebCompanyCandidates(texas300Plan(), 3, search, {
      maxQueries: 6,
      delayMs: 0,
      concurrency: 2,
    });
    expect(collected.yieldSnapshot).toBeDefined();
    expect(collected.stopReason).toBeTruthy();
    expect(typeof collected.yieldPerQuery).toBe('number');
    expect(typeof collected.rejectionSummary).toBe('string');
  });
});
