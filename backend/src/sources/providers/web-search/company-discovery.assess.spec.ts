import type { SearchPlan } from '../../../search/types/search-plan.types';
import type { WebSearchResult } from '../../../enrichment/website/web-search.types';
import { assessWebCompanyCandidate, collectWebCompanyCandidates, companyDiscoveryQueries } from './company-discovery.assess';

const plan: SearchPlan = {
  industry: ['real_estate'],
  leadTypes: ['real_estate_investor'],
  locations: [{ country: 'US', state: 'Texas' }],
  companySize: { min: 1, max: 50 },
  companyFields: [],
  maxResults: 500,
  unresolvedCriteria: [],
};

function hit(overrides: Partial<WebSearchResult> = {}): WebSearchResult {
  return {
    title: 'Oak Stream Investors | Home',
    url: 'https://oakstream.example/',
    snippet: 'Oak Stream Investors is a real estate investment company in Austin, Texas.',
    source: 'tavily',
    retrievedAt: '2026-09-28T00:00:00.000Z',
    ...overrides,
  };
}

describe('web company discovery', () => {
  it('builds more than one Texas query and does not stop after the first page', () => {
    const queries = companyDiscoveryQueries(plan, 12);
    expect(queries.length).toBe(12);
    expect(new Set(queries).size).toBe(12);
    expect(queries[0]).toContain('Houston');
    expect(queries.some((query) => query.includes('Dallas'))).toBe(true);
  });

  it('accepts an official Texas real-estate investor page', () => {
    const decision = assessWebCompanyCandidate(hit(), plan);
    expect(decision.accepted).toBe(true);
    if (!decision.accepted) return;
    expect(decision.result).toMatchObject({
      name: 'Oak Stream Investors',
      website: 'https://oakstream.example',
      address: { city: 'Austin', state: 'Texas', country: 'US' },
      category: 'real_estate_investor',
    });
    expect(decision.result.rawData).toMatchObject({ snippet: expect.stringContaining('Austin, Texas') });
  });

  it.each([
    ['https://www.linkedin.com/company/oak-stream', 'SOCIAL_PROFILE'],
    ['https://www.facebook.com/oakstream', 'SOCIAL_PROFILE'],
    ['https://www.instagram.com/oakstream', 'SOCIAL_PROFILE'],
    ['https://www.glassdoor.com/oak-stream', 'REVIEW_SITE'],
    ['https://www.rocketreach.co/oak-stream', 'DIRECTORY'],
    ['https://startupintros.com/oak-stream', 'DIRECTORY'],
    ['https://www.indeed.com/cmp/oak-stream', 'JOB_BOARD'],
    ['https://www.forbes.com/oak-stream', 'NEWS_ARTICLE'],
    ['https://materials.proxyvote.com/oak', 'PROXY_OR_FILING'],
  ])('rejects %s as %s', (url, reason) => {
    expect(assessWebCompanyCandidate(hit({ url }), plan)).toEqual({ accepted: false, reason });
  });

  it('rejects list pages, companies outside Texas, unrelated businesses, and a Texas name with no location evidence', () => {
    expect(assessWebCompanyCandidate(hit({ title: 'Top 10 real estate investors in Texas' }), plan).accepted).toBe(false);
    expect(assessWebCompanyCandidate(hit({ snippet: 'Oak Stream Investors is a real estate investor in Denver, Colorado.' }), plan)).toMatchObject({ accepted: false, reason: 'OUTSIDE_REQUESTED_LOCATION' });
    expect(assessWebCompanyCandidate(hit({ snippet: 'Oak Stream Investors is a dentist in Austin, Texas.' }), plan)).toMatchObject({ accepted: false, reason: 'NOT_REAL_ESTATE_INVESTOR' });
    expect(assessWebCompanyCandidate(hit({
      title: 'Texas Oak Holdings | Home',
      snippet: 'Texas Oak Holdings buys apartment buildings.',
    }), plan)).toMatchObject({ accepted: false, reason: 'OUTSIDE_REQUESTED_LOCATION' });
  });

  it('keeps separate offices and collapses the same company on one host', () => {
    const austin = assessWebCompanyCandidate(hit(), plan);
    const dallas = assessWebCompanyCandidate(hit({
      title: 'Oak Stream Investors Dallas | Home',
      url: 'https://dallas.oakstream.example/',
      snippet: 'Oak Stream Investors Dallas is a real estate investment firm in Dallas, Texas.',
    }), plan);
    const repeat = assessWebCompanyCandidate(hit({ url: 'https://oakstream.example/about' }), plan);
    expect(austin.accepted && dallas.accepted && repeat.accepted).toBe(true);
    if (!austin.accepted || !dallas.accepted || !repeat.accepted) return;
    expect(austin.result.externalId).not.toBe(dallas.result.externalId);
    expect(austin.result.address?.city).toBe('Austin');
    expect(dallas.result.address?.city).toBe('Dallas');
    expect(austin.result.externalId).toBe(repeat.result.externalId);
  });

  it('stops at the requested target and keeps going after a single 5xx', async () => {
    let calls = 0;
    const search = jest.fn(async () => {
      calls += 1;
      if (calls === 2) throw new Error('Web search provider returned HTTP 502.');
      return [hit({
        title: `Firm ${calls} Capital | Home`,
        url: `https://firm${calls}.example/`,
        snippet: `Firm ${calls} Capital is a real estate investment company in Austin, Texas.`,
      })];
    });
    const collected = await collectWebCompanyCandidates(plan, 3, search, { maxQueries: 6, delayMs: 0 });
    expect(collected.results).toHaveLength(3);
    expect(collected.providerError).toBeNull();
    expect(search.mock.calls.length).toBeGreaterThan(3);
  });

  it('returns the companies already found when the provider returns 429 or times out', async () => {
    const search = jest.fn()
      .mockResolvedValueOnce([hit()])
      .mockRejectedValueOnce(new Error('Web search provider rate limit reached.'));
    const limited = await collectWebCompanyCandidates(plan, 500, search, { maxQueries: 5, delayMs: 0 });
    expect(limited.results).toHaveLength(1);
    expect(limited.providerError).toMatch(/rate limit/i);
    expect(search).toHaveBeenCalledTimes(2);

    const timeout = jest.fn().mockRejectedValue(new Error('Web search provider timed out.'));
    const timed = await collectWebCompanyCandidates(plan, 500, timeout, { maxQueries: 4, delayMs: 0 });
    expect(timed.results).toEqual([]);
    expect(timed.providerError).toMatch(/timed out/i);
    expect(timeout).toHaveBeenCalledTimes(1);
  });

  it('does not invent companies for an empty result set and stays idempotent', async () => {
    const search = jest.fn().mockResolvedValue([hit(), hit({ url: 'https://oakstream.example/team' })]);
    const first = await collectWebCompanyCandidates(plan, 500, search, { maxQueries: 2, delayMs: 0 });
    const second = await collectWebCompanyCandidates(plan, 500, search, { maxQueries: 2, delayMs: 0 });
    expect(first.results).toHaveLength(1);
    expect(second.results[0]?.externalId).toBe(first.results[0]?.externalId);
    const empty = await collectWebCompanyCandidates(plan, 500, async () => [], { maxQueries: 2, delayMs: 0 });
    expect(empty.results).toEqual([]);
  });

  it('searches the requested industry and place instead of Texas real estate', () => {
    const software = companyDiscoveryQueries({
      ...plan,
      industry: ['software'],
      leadTypes: [],
      locations: [{ country: 'US', state: 'California' }],
      companySize: undefined,
      maxResults: 300,
      requestedCount: 300,
    }, 8);
    expect(software.some((query) => /software/i.test(query) && /California|Los Angeles|San Francisco/i.test(query))).toBe(true);
    expect(software.some((query) => /Houston|real estate investment/i.test(query))).toBe(false);

    const restaurants = companyDiscoveryQueries({
      ...plan,
      industry: ['restaurant'],
      leadTypes: [],
      locations: [{ city: 'Dubai', country: 'United Arab Emirates' }],
      companySize: undefined,
      requestedCount: 75,
    }, 4);
    expect(restaurants[0]).toMatch(/restaurant/i);
    expect(restaurants[0]).toMatch(/Dubai/i);
  });

  it('accepts a software company in California and rejects it for a real-estate investor search', () => {
    const softwarePlan: SearchPlan = {
      ...plan,
      industry: ['software'],
      leadTypes: [],
      locations: [{ country: 'US', state: 'California' }],
      companySize: undefined,
      requestedCount: 100,
    };
    const page = hit({
      title: 'Northwind Software | Home',
      url: 'https://northwind.example/',
      snippet: 'Northwind Software builds developer tools in San Francisco, California.',
    });
    const accepted = assessWebCompanyCandidate(page, softwarePlan);
    expect(accepted.accepted).toBe(true);
    if (accepted.accepted) expect(accepted.result.category).toBe('software');
    expect(assessWebCompanyCandidate(page, plan).accepted).toBe(false);
  });

  it('returns a partial set when later queries fail and does not pad the requested count', async () => {
    const softwarePlan: SearchPlan = {
      ...plan,
      industry: ['software'],
      leadTypes: [],
      locations: [{ country: 'US', state: 'California' }],
      companySize: undefined,
      requestedCount: 10,
    };
    const search = jest.fn()
      .mockResolvedValueOnce([hit({
        title: 'Northwind Software | Home',
        url: 'https://northwind.example/',
        snippet: 'Northwind Software builds developer tools in San Francisco, California.',
      })])
      .mockRejectedValueOnce(new Error('Web search provider returned HTTP 502.'))
      .mockResolvedValue([]);
    const collected = await collectWebCompanyCandidates(softwarePlan, 10, async (query) => search(query), { maxQueries: 4, delayMs: 0 });
    expect(collected.results).toHaveLength(1);
    expect(collected.results).not.toHaveLength(10);
  });
});
