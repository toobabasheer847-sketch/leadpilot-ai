import { SourceProviderError } from '../providers/source-provider.error';
import type { NormalizedSourceResult, SourceProvider } from '../types/source.types';
import type { SearchPlan } from '../../search/types/search-plan.types';
import {
  discoveryAcceptanceCap,
  discoveryQueryBudget,
  discoveryTarget,
  resolveCountIntent,
} from '../../search/search-plan.limits';
import { discoveryMapProviderChain } from '../providers/provider-selection';
import { DiscoveryExecutionCircuit } from './discovery-execution-circuit';
import {
  detectDiscoveryProviderCapabilities,
  usableMapProviders,
} from './discovery-provider-capabilities';
import { dedupeDiscoveryCandidates } from './discovery-fallback';
import { SourceDiscoveryService } from './source-discovery.service';

/** Phase R Texas real-estate investor prompt equivalent. */
const texasInvestorPlan: SearchPlan = {
  industry: ['real_estate'],
  leadTypes: ['real_estate_investor'],
  locations: [{ country: 'US', state: 'Texas' }],
  companyFields: [],
  maxResults: 300,
  requestedCount: 300,
  countIntent: 'exact',
  unresolvedCriteria: [],
  searchIntent: 'real estate investment companies specializing in cash home buying, fix and flip, or wholesaling',
  exclusions: ['realtor', 'mortgage company', 'attorney', 'photographer', 'software company', 'construction company'],
};

function company(name: string, website: string, city = 'Austin'): NormalizedSourceResult {
  return {
    externalId: `id:${website}`,
    name,
    website,
    sourceUrl: website,
    address: { city, state: 'Texas', country: 'US' },
    category: 'real estate investment',
  };
}

function mapProvider(name: string, searchBusinesses: SourceProvider['searchBusinesses'], configured = true): SourceProvider {
  return {
    name,
    providerName: () => name,
    getSourceType: () => name,
    getProviderName: () => name,
    metadata: () => ({ provider: name, sourceType: name, synthetic: false }),
    health: () => ({ name, configured, enabled: configured }),
    searchBusinesses,
    search: searchBusinesses,
    normalizeResult: (raw: unknown) => raw as NormalizedSourceResult,
  } as SourceProvider;
}

function buildService(input: {
  chain: SourceProvider[];
  collect?: jest.Mock;
  refillRounds?: number;
  webConfigured?: boolean;
}) {
  const primary = input.chain[0];
  const usage = {
    checkRequestRate: jest.fn().mockResolvedValue(undefined),
    recordUsage: jest.fn().mockResolvedValue(undefined),
  };
  const providerObservability = {
    track: jest.fn(async (_provider: string, _operation: string, callback: () => Promise<{ value: unknown }>) => {
      const result = await callback();
      return result.value;
    }),
  };
  const requestContext = { get: jest.fn().mockReturnValue(undefined) };
  const webDiscovery = {
    collect: input.collect ?? jest.fn().mockResolvedValue({ results: [], rejected: 0, providerError: null, queriesRun: 0 }),
  };
  const config = {
    get: (key: string, fallback?: unknown) => {
      if (key === 'sourceProvider.discoveryRefillRounds') return input.refillRounds ?? 0;
      if (key === 'webSearch.provider') return 'tavily';
      if (key === 'webSearch.tavilyApiKey') return input.webConfigured === false ? '' : 'test-key';
      return fallback ?? 0;
    },
  };
  const persisted: NormalizedSourceResult[] = [];
  const service = new SourceDiscoveryService(
    {} as never,
    primary,
    input.chain,
    { normalize: (value: NormalizedSourceResult) => value } as never,
    usage as never,
    providerObservability as never,
    requestContext as never,
    webDiscovery as never,
    config as never,
  );
  const audit = jest.spyOn(service as never as { audit: (...args: unknown[]) => Promise<void> }, 'audit').mockResolvedValue(undefined);
  jest.spyOn(service as never as { persistResults: (...args: unknown[]) => Promise<number> }, 'persistResults')
    .mockImplementation(async (_organizationId, _executionId, _provider, results: NormalizedSourceResult[]) => {
      let added = 0;
      for (const result of results) {
        const website = result.website?.replace(/\/$/, '').toLowerCase();
        const duplicate = persisted.some((row) => row.website?.replace(/\/$/, '').toLowerCase() === website && website);
        if (duplicate) continue;
        persisted.push(result);
        added += 1;
      }
      return added;
    });
  return { service, webDiscovery, audit, persisted, usage };
}

describe('Phase R discovery provider fallback, coverage & capacity', () => {
  it('preserves exact-300 Texas investor count intent', () => {
    expect(resolveCountIntent(texasInvestorPlan)).toBe('exact');
    expect(discoveryTarget(texasInvestorPlan)).toBe(300);
    expect(discoveryAcceptanceCap(texasInvestorPlan)).toBe(300);
    expect(discoveryQueryBudget(300)).toBe(600);
  });

  it('detects configured vs missing providers without exposing secrets', () => {
    const google = mapProvider('google_places', jest.fn(), true);
    const osm = mapProvider('osm', jest.fn(), false);
    const snapshot = detectDiscoveryProviderCapabilities({
      mapProviders: [osm, google],
      webSearchConfigured: true,
      includeWebSearch: true,
    });
    expect(snapshot.mapProvidersAvailable).toEqual(['google_places']);
    expect(snapshot.unavailableProviders).toEqual(['osm']);
    expect(snapshot.webSearchAvailable).toBe(true);
    expect(snapshot.summary).not.toMatch(/api[_-]?key|secret|bearer/i);
    expect(usableMapProviders([osm, google], snapshot).map((p) => p.providerName())).toEqual(['google_places']);
  });

  it('skips unconfigured Google Places and continues with OSM + Web', async () => {
    const osmCompany = company('Texas Cash Closers', 'https://texascash.example', 'Houston');
    const unconfiguredGoogleSearch = jest.fn().mockRejectedValue(
      new SourceProviderError('PROVIDER_NOT_CONFIGURED', 'Google Places provider is not configured.'),
    );
    const unconfiguredGoogle = mapProvider('google_places', unconfiguredGoogleSearch, false);
    const osmSearch = jest.fn().mockResolvedValue({
      provider: 'osm',
      results: [osmCompany],
      queriesRun: 2,
    });
    const osm = mapProvider('osm', osmSearch, true);
    let calls = 0;
    const webCompany = company('Flip Ready Capital', 'https://flipready.example', 'Dallas');
    const collect = jest.fn()
      .mockImplementation(async (_plan, _need, _exclude, _round, stream?: { onBatch?: (batch: NormalizedSourceResult[]) => Promise<void> }) => {
        calls += 1;
        if (calls > 1) return { results: [], rejected: 0, providerError: null, queriesRun: 0 };
        if (stream?.onBatch) await stream.onBatch([webCompany]);
        return { results: [webCompany], rejected: 0, providerError: null, queriesRun: 3 };
      });
    const { service, audit, persisted } = buildService({
      chain: [unconfiguredGoogle, osm],
      collect,
    });

    const result = await service.discover('exec-r1', 'org-r1', texasInvestorPlan);
    expect(unconfiguredGoogleSearch).not.toHaveBeenCalled();
    expect(osmSearch).toHaveBeenCalledTimes(1);
    expect(result.candidates).toBe(2);
    expect(result.providersSkipped).toBeGreaterThanOrEqual(1);
    expect(result.capabilitySummary).toMatch(/Google Places: NOT CONFIGURED/);
    expect(persisted.map((row) => row.website).sort((a, b) => (a ?? '').localeCompare(b ?? ''))).toEqual([
      'https://flipready.example',
      'https://texascash.example',
    ]);
    expect(audit.mock.calls.some((call) => call[2] === 'DISCOVERY_PROVIDER_CAPABILITIES')).toBe(true);
  });

  it('Texas remains on the SearchPlan; investor intent and exclusions are preserved', async () => {
    const osmSearch = jest.fn().mockResolvedValue({ provider: 'osm', results: [], queriesRun: 1 });
    const googleSearch = jest.fn().mockResolvedValue({
      provider: 'google_places',
      results: [company('Lone Star Wholesalers', 'https://lonestar-wholesale.example')],
      queriesRun: 4,
    });
    const osm = mapProvider('osm', osmSearch);
    const google = mapProvider('google_places', googleSearch);
    const collect = jest.fn().mockResolvedValue({ results: [], rejected: 0, providerError: null, queriesRun: 1 });
    const { service } = buildService({ chain: [osm, google], collect });

    await service.discover('exec-r2', 'org-r2', texasInvestorPlan);

    for (const search of [osmSearch, googleSearch]) {
      expect(search).toHaveBeenCalledWith(expect.objectContaining({
        locations: [{ country: 'US', state: 'Texas' }],
        leadTypes: ['real_estate_investor'],
        searchIntent: expect.stringMatching(/cash home buying|fix and flip|wholesaling/i),
        exclusions: expect.arrayContaining(['realtor', 'mortgage company', 'software company']),
      }), expect.any(Object));
      const planArg = search.mock.calls[0]?.[0] as SearchPlan;
      expect(planArg.locations).toEqual([{ country: 'US', state: 'Texas' }]);
      expect(planArg.locations.some((loc) => /Houston|Dallas/i.test(loc.city ?? ''))).toBe(false);
    }
  });

  it('one provider failure does not stop another configured provider', async () => {
    const osmSearch = jest.fn().mockResolvedValue({
      provider: 'osm',
      results: [],
      providerError: 'OpenStreetMap discovery could not resolve the search location.',
      queriesRun: 1,
    });
    const googleSearch = jest.fn().mockResolvedValue({
      provider: 'google_places',
      results: [company('Cash Offer TX', 'https://cashoffertx.example', 'San Antonio')],
      queriesRun: 5,
    });
    const collect = jest.fn().mockResolvedValue({
      results: [],
      rejected: 0,
      providerError: 'Web search provider plan limit exceeded.',
      queriesRun: 20,
    });
    const osm = mapProvider('osm', osmSearch);
    const google = mapProvider('google_places', googleSearch);
    const chain = discoveryMapProviderChain('development', 'osm', google, osm, mapProvider('fake', jest.fn()));
    const { service } = buildService({ chain, collect });

    const result = await service.discover('exec-r3', 'org-r3', texasInvestorPlan);
    expect(result.candidates).toBe(1);
    expect(googleSearch).toHaveBeenCalled();
    expect(result.providerStatusSummary).toMatch(/OpenStreetMap — LOCATION RESOLUTION FAILED/);
    expect(result.providerStatusSummary).toMatch(/Google Places — COMPLETED/);
    expect(result.providerStatusSummary).toMatch(/Web Search — QUOTA EXCEEDED/);
    expect(result.shortfall).toBe(299);
  });

  it('circuit breaker prevents repeated calls to a failed provider', async () => {
    let googleCalls = 0;
    const googleSearch = jest.fn().mockImplementation(async () => {
      googleCalls += 1;
      throw new SourceProviderError('PROVIDER_QUOTA_EXCEEDED', 'Google Places provider quota was exceeded.');
    });
    const osmSearch = jest.fn().mockResolvedValue({
      provider: 'osm',
      results: [company('Hill Country Buyers', 'https://hillcountry-buyers.example')],
      queriesRun: 1,
    });
    const collect = jest.fn().mockResolvedValue({
      results: [],
      rejected: 0,
      providerError: 'Web search provider plan limit exceeded.',
      queriesRun: 10,
    });
    const { service } = buildService({
      chain: [mapProvider('google_places', googleSearch), mapProvider('osm', osmSearch)],
      collect,
      refillRounds: 4,
    });

    await service.discover('exec-r4', 'org-r4', texasInvestorPlan);
    expect(googleCalls).toBe(1);
    expect(osmSearch).toHaveBeenCalledTimes(1);
    expect(collect).toHaveBeenCalledTimes(1);

    const circuit = new DiscoveryExecutionCircuit('exec-r4b', 'org-r4');
    circuit.trip('web_search', 'QUOTA_EXCEEDED', 'quota');
    expect(circuit.isUnavailable('web_search')).toBe(true);
  });

  it('deduplicates the same company across providers toward the requested count', async () => {
    const shared = company('Oak Stream Investors', 'https://oakstream.example/', 'Austin');
    const osmOnly = company('Cedar Range Capital', 'https://cedarrange.example', 'Dallas');
    const osmSearch = jest.fn().mockResolvedValue({
      provider: 'osm',
      results: [shared, osmOnly],
      queriesRun: 2,
    });
    const googleSearch = jest.fn().mockResolvedValue({
      provider: 'google_places',
      results: [shared, company('Bayou Fix Flip', 'https://bayoufix.example', 'Houston')],
      queriesRun: 3,
    });
    const collect = jest.fn().mockResolvedValue({ results: [], rejected: 0, providerError: null, queriesRun: 0 });
    const { service, persisted } = buildService({
      chain: [mapProvider('osm', osmSearch), mapProvider('google_places', googleSearch)],
      collect,
    });

    const result = await service.discover('exec-r5', 'org-r5', texasInvestorPlan);
    expect(result.candidates).toBe(3);
    expect(result.duplicatesRemoved).toBeGreaterThanOrEqual(1);
    expect(persisted.filter((row) => row.website?.includes('oakstream')).length).toBe(1);
    expect(result.shortfall).toBe(297);

    const cross = dedupeDiscoveryCandidates([shared], [shared, osmOnly]);
    expect(cross.accepted).toHaveLength(1);
    expect(cross.duplicatesRemoved).toBe(1);
  });

  it('reports honest shortfall and never fabricates remaining companies', async () => {
    const found = Array.from({ length: 87 }, (_, index) => company(
      `Investor ${index + 1}`,
      `https://investor-${index + 1}.example`,
      index % 2 === 0 ? 'Austin' : 'Dallas',
    ));
    const googleSearch = jest.fn().mockResolvedValue({
      provider: 'google_places',
      results: found,
      queriesRun: 40,
    });
    const collect = jest.fn().mockResolvedValue({ results: [], rejected: 0, providerError: null, queriesRun: 5 });
    const { service, persisted } = buildService({
      chain: [mapProvider('google_places', googleSearch)],
      collect,
    });

    const result = await service.discover('exec-r6', 'org-r6', texasInvestorPlan);
    expect(result.requested).toBe(300);
    expect(result.countIntent).toBe('exact');
    expect(result.candidates).toBe(87);
    expect(result.accepted).toBe(87);
    expect(result.shortfall).toBe(213);
    expect(persisted).toHaveLength(87);
    expect(persisted).not.toHaveLength(300);
  });

  it('early-stops once acceptanceCap is reached without fabricating extras', async () => {
    const batch = Array.from({ length: 320 }, (_, index) => company(
      `Cap Company ${index + 1}`,
      `https://cap-${index + 1}.example`,
      'Austin',
    ));
    const googleSearch = jest.fn().mockResolvedValue({
      provider: 'google_places',
      results: batch.slice(0, 300),
      queriesRun: 50,
    });
    const osmSearch = jest.fn().mockResolvedValue({
      provider: 'osm',
      results: batch.slice(300),
      queriesRun: 10,
    });
    const collect = jest.fn();
    const { service, persisted } = buildService({
      chain: [mapProvider('google_places', googleSearch), mapProvider('osm', osmSearch)],
      collect,
    });

    const result = await service.discover('exec-r7', 'org-r7', texasInvestorPlan);
    expect(result.candidates).toBe(300);
    expect(result.shortfall).toBe(0);
    expect(persisted).toHaveLength(300);
    expect(osmSearch).not.toHaveBeenCalled();
    expect(collect).not.toHaveBeenCalled();
  });

  it('tracks per-provider metrics for UI observability', async () => {
    const osmSearch = jest.fn().mockResolvedValue({
      provider: 'osm',
      results: [],
      providerError: 'OpenStreetMap discovery could not resolve the search location.',
      queriesRun: 1,
    });
    const googleSearch = jest.fn().mockResolvedValue({
      provider: 'google_places',
      results: [company('Places Investors', 'https://places-investors.example')],
      queriesRun: 6,
    });
    const collect = jest.fn().mockResolvedValue({
      results: [],
      rejected: 2,
      providerError: 'Web search provider plan limit exceeded.',
      queriesRun: 20,
    });
    const { service, audit } = buildService({
      chain: [mapProvider('osm', osmSearch), mapProvider('google_places', googleSearch)],
      collect,
    });

    const result = await service.discover('exec-r8', 'org-r8', texasInvestorPlan);
    expect(result.providerQueries).toBeGreaterThan(0);
    expect(result.queriesSkipped).toBeGreaterThan(0);
    expect(result.providerAttempts?.some((attempt) => attempt.provider === 'osm' && attempt.errorCategory === 'LOCATION_RESOLUTION_FAILED')).toBe(true);
    expect(result.providerAttempts?.some((attempt) => attempt.provider === 'web_search' && attempt.errorCategory === 'QUOTA_EXCEEDED')).toBe(true);
    const discovered = audit.mock.calls.find((call) => call[2] === 'CANDIDATES_DISCOVERED');
    expect(discovered?.[4]).toMatchObject({
      requested: '300',
      accepted: '1',
      shortfall: '299',
      providerStatusSummary: expect.stringMatching(/Google Places — COMPLETED/),
    });
  });

  it('does not crash when web is unconfigured if a map provider succeeds', async () => {
    const googleSearch = jest.fn().mockResolvedValue({
      provider: 'google_places',
      results: [company('Configured Places Co', 'https://configured-places.example')],
      queriesRun: 2,
    });
    const collect = jest.fn();
    const { service } = buildService({
      chain: [mapProvider('google_places', googleSearch)],
      collect,
      webConfigured: false,
    });

    const result = await service.discover('exec-r9', 'org-r9', texasInvestorPlan);
    expect(result.candidates).toBe(1);
    expect(collect).not.toHaveBeenCalled();
    expect(result.providerStatusSummary).toMatch(/Web Search — CONFIGURATION ERROR/);
  });

  it('300-company performance path stays bounded (no unbounded provider fan-out)', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const googleSearch = jest.fn().mockImplementation(async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await Promise.resolve();
      concurrent -= 1;
      return {
        provider: 'google_places',
        results: [company('Perf Investor', 'https://perf-investor.example')],
        queriesRun: 8,
      };
    });
    const osmSearch = jest.fn().mockImplementation(async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await Promise.resolve();
      concurrent -= 1;
      return { provider: 'osm', results: [], queriesRun: 1 };
    });
    const collect = jest.fn().mockResolvedValue({ results: [], rejected: 0, providerError: null, queriesRun: 2 });
    const { service } = buildService({
      chain: [mapProvider('google_places', googleSearch), mapProvider('osm', osmSearch)],
      collect,
    });

    await service.discover('exec-r10', 'org-r10', texasInvestorPlan);
    // Map providers run sequentially in the discovery orchestrator (bounded), not via unbounded Promise.all.
    expect(maxConcurrent).toBe(1);
    expect(googleSearch).toHaveBeenCalledTimes(1);
    expect(osmSearch).toHaveBeenCalledTimes(1);
  });
});
