import { SourceProviderError } from '../providers/source-provider.error';
import type { NormalizedSourceResult, SourceProvider } from '../types/source.types';
import type { SearchPlan } from '../../search/types/search-plan.types';
import { discoveryAcceptanceCap, discoveryTarget, resolveCountIntent } from '../../search/search-plan.limits';
import { discoveryMapProviderChain } from '../providers/provider-selection';
import { DiscoveryExecutionCircuit } from './discovery-execution-circuit';
import {
  aggregateDiscoveryFailure,
  classifyDiscoveryProviderOutcome,
  discoveryCompletedWithLimitationsMessage,
  discoveryProgressSummary,
  type DiscoveryProviderAttempt,
} from './discovery-provider-outcome';
import { SourceDiscoveryService } from './source-discovery.service';

const texasPlan: SearchPlan = {
  industry: ['real_estate'],
  leadTypes: ['real_estate_investor'],
  locations: [{ country: 'US', state: 'Texas' }],
  companyFields: [],
  maxResults: 300,
  requestedCount: 300,
  countIntent: 'exact',
  unresolvedCriteria: [],
  searchIntent: 'real estate investment companies specializing in cash home buyers, fix and flip, or wholesaling',
  exclusions: ['realtors', 'mortgage companies', 'property managers'],
};

function company(name: string, website: string, city = 'Austin'): NormalizedSourceResult {
  return {
    externalId: `id:${website}`,
    name,
    website,
    sourceUrl: website,
    address: { city, state: 'Texas', country: 'US' },
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
      if (key === 'webSearch.tavilyApiKey') return 'test-key';
      if (key === 'webSearch.provider') return 'tavily';
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
      persisted.push(...results);
      return results.length;
    });
  return { service, webDiscovery, audit, persisted, usage };
}

describe('Phase Q resilient discovery providers', () => {
  it('A. Web Search quota exceeded → Google Places continues', async () => {
    const placesCompany = company('Lone Star Acquisitions', 'https://lonestar.example', 'Dallas');
    const google = mapProvider('google_places', jest.fn().mockResolvedValue({
      provider: 'google_places',
      results: [placesCompany],
      queriesRun: 3,
    }));
    const collect = jest.fn().mockResolvedValue({
      results: [],
      rejected: 0,
      providerError: 'Web search provider plan limit exceeded.',
      queriesRun: 20,
    });
    const { service, persisted } = buildService({ chain: [google], collect });

    await expect(service.discover('exec-a', 'org-a', texasPlan)).resolves.toMatchObject({
      candidates: 1,
      shortfall: 299,
      providersQuotaExceeded: 1,
    });
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.name).toBe('Lone Star Acquisitions');
  });

  it('B. Web Search quota exceeded → OSM continues if usable', async () => {
    const osmCompany = company('Hill Country Capital', 'https://hillcountry.example', 'Austin');
    const osm = mapProvider('osm', jest.fn().mockResolvedValue({
      provider: 'osm',
      results: [osmCompany],
      queriesRun: 2,
    }));
    const collect = jest.fn().mockResolvedValue({
      results: [],
      rejected: 0,
      providerError: 'Web search provider plan limit exceeded.',
      queriesRun: 5,
    });
    const { service } = buildService({ chain: [osm], collect });

    await expect(service.discover('exec-b', 'org-b', texasPlan)).resolves.toMatchObject({
      candidates: 1,
      webError: 'Web search provider plan limit exceeded.',
    });
  });

  it('C. OSM location resolution failure → Web Search continues', async () => {
    const webCompany = company('Cash Offer Partners', 'https://cashoffer.example', 'Houston');
    const osm = mapProvider('osm', jest.fn().mockResolvedValue({
      provider: 'osm',
      results: [],
      providerError: 'OpenStreetMap discovery could not resolve the search location.',
      queriesRun: 1,
    }));
    let calls = 0;
    const collect = jest.fn()
      .mockImplementation(async (_plan, _need, _exclude, _round, stream?: { onBatch?: (batch: NormalizedSourceResult[]) => Promise<void> }) => {
        calls += 1;
        if (calls > 1) return { results: [], rejected: 0, providerError: null, queriesRun: 0 };
        if (stream?.onBatch) await stream.onBatch([webCompany]);
        return { results: [webCompany], rejected: 0, providerError: null, queriesRun: 4 };
      });
    const { service } = buildService({ chain: [osm], collect });

    await expect(service.discover('exec-c', 'org-c', texasPlan)).resolves.toMatchObject({ candidates: 1 });
    expect(collect).toHaveBeenCalled();
  });

  it('D. One provider temporary failure → other providers continue', async () => {
    const googleCompany = company('Flip Fund Texas', 'https://flipfund.example', 'Fort Worth');
    const osmSearch = jest.fn().mockRejectedValue(
      new SourceProviderError('PROVIDER_TIMEOUT', 'OpenStreetMap provider request timed out.'),
    );
    const googleSearch = jest.fn().mockResolvedValue({
      provider: 'google_places',
      results: [googleCompany],
      queriesRun: 2,
    });
    const osm = mapProvider('osm', osmSearch);
    const google = mapProvider('google_places', googleSearch);
    const { service, webDiscovery } = buildService({
      chain: [osm, google],
      collect: jest.fn().mockResolvedValue({ results: [], rejected: 0, providerError: null, queriesRun: 0 }),
    });

    await expect(service.discover('exec-d', 'org-d', texasPlan)).resolves.toMatchObject({ candidates: 1 });
    expect(googleSearch).toHaveBeenCalled();
    expect(webDiscovery.collect).toHaveBeenCalled();
  });

  it('E. One provider EMPTY → not treated as fatal', async () => {
    const osm = mapProvider('osm', jest.fn().mockResolvedValue({
      provider: 'osm',
      results: [],
      queriesRun: 2,
    }));
    const collect = jest.fn().mockResolvedValue({ results: [], rejected: 0, providerError: null, queriesRun: 3 });
    const { service } = buildService({ chain: [osm], collect });

    await expect(service.discover('exec-e', 'org-e', texasPlan)).resolves.toMatchObject({
      candidates: 0,
      shortfall: 300,
      providersEmpty: expect.any(Number),
    });
  });

  it('F. All providers unavailable → Discovery FAILED', async () => {
    const osm = mapProvider('osm', jest.fn().mockResolvedValue({
      provider: 'osm',
      results: [],
      providerError: 'OpenStreetMap discovery could not resolve the search location.',
      queriesRun: 1,
    }));
    const google = mapProvider('google_places', jest.fn().mockRejectedValue(
      new SourceProviderError('PROVIDER_NOT_CONFIGURED', 'Google Places provider is not configured.'),
    ));
    const collect = jest.fn().mockResolvedValue({
      results: [],
      rejected: 0,
      providerError: 'Web search provider plan limit exceeded.',
      queriesRun: 1,
    });
    const { service } = buildService({ chain: [osm, google], collect });

    await expect(service.discover('exec-f', 'org-f', texasPlan)).rejects.toMatchObject({
      message: expect.stringMatching(/Discovery failed because all configured providers were unavailable[\s\S]*OpenStreetMap: location resolution failed[\s\S]*Google Places: configuration error[\s\S]*Web Search: quota exceeded/i),
    });
  });

  it('G. One provider succeeds with fewer results → honest shortfall', async () => {
    const companies = [
      company('Alpha Buyers', 'https://alpha-buyers.example', 'Austin'),
      company('Beta Wholesalers', 'https://beta-wholesale.example', 'Dallas'),
    ];
    const google = mapProvider('google_places', jest.fn().mockResolvedValue({
      provider: 'google_places',
      results: companies,
      queriesRun: 4,
    }));
    const { service, persisted } = buildService({
      chain: [google],
      collect: jest.fn().mockResolvedValue({ results: [], rejected: 0, providerError: null, queriesRun: 2 }),
    });

    const result = await service.discover('exec-g', 'org-g', texasPlan);
    expect(result.candidates).toBe(2);
    expect(result.shortfall).toBe(298);
    expect(persisted).toHaveLength(2);
    expect(persisted).not.toHaveLength(300);
  });

  it('H. Exact 300 target remains exact', () => {
    expect(resolveCountIntent(texasPlan)).toBe('exact');
    expect(discoveryTarget(texasPlan)).toBe(300);
    expect(discoveryAcceptanceCap(texasPlan)).toBe(300);
  });

  it('I. No fabricated records are created', async () => {
    const google = mapProvider('google_places', jest.fn().mockResolvedValue({
      provider: 'google_places',
      results: [company('Only One', 'https://only-one.example')],
      queriesRun: 1,
    }));
    const { service, persisted } = buildService({
      chain: [google],
      collect: jest.fn().mockResolvedValue({ results: [], rejected: 0, providerError: null, queriesRun: 0 }),
    });
    const result = await service.discover('exec-i', 'org-i', texasPlan);
    expect(result.candidates).toBe(1);
    expect(persisted).toHaveLength(1);
    expect(result.shortfall).toBe(299);
  });

  it('J. Provider circuit breaker prevents repeated quota calls', async () => {
    const circuit = new DiscoveryExecutionCircuit('exec-j', 'org-j');
    expect(circuit.trip('web_search', 'QUOTA_EXCEEDED', 'Web search provider plan limit exceeded.')).toBe(true);
    expect(circuit.isUnavailable('web_search')).toBe(true);
    expect(circuit.trip('web_search', 'QUOTA_EXCEEDED', 'again')).toBe(false);
    expect(circuit.scope()).toEqual({ executionId: 'exec-j', organizationId: 'org-j' });
  });

  it('K. Query budget is not wasted after provider becomes unavailable', async () => {
    let googleCalls = 0;
    const googleSearch = jest.fn().mockImplementation(async () => {
      googleCalls += 1;
      throw new SourceProviderError('PROVIDER_QUOTA_EXCEEDED', 'Google Places provider quota was exceeded.');
    });
    const osmSearch = jest.fn().mockResolvedValue({
      provider: 'osm',
      results: [company('OSM Investor', 'https://osm-investor.example')],
      queriesRun: 1,
    });
    const google = mapProvider('google_places', googleSearch);
    const osm = mapProvider('osm', osmSearch);
    const collect = jest.fn().mockResolvedValue({
      results: [],
      rejected: 0,
      providerError: 'Web search provider plan limit exceeded.',
      queriesRun: 20,
    });
    const { service } = buildService({ chain: [google, osm], collect, refillRounds: 4 });

    const result = await service.discover('exec-k', 'org-k', texasPlan);
    expect(googleCalls).toBe(1);
    expect(osmSearch).toHaveBeenCalledTimes(1);
    expect(collect).toHaveBeenCalledTimes(1);
    expect(result.queriesSkipped).toBeGreaterThan(0);
    expect(result.candidates).toBe(1);
  });

  it('L. Provider status appears in discovery progress', async () => {
    const osm = mapProvider('osm', jest.fn().mockResolvedValue({
      provider: 'osm',
      results: [],
      providerError: 'OpenStreetMap discovery could not resolve the search location.',
      queriesRun: 1,
    }));
    const google = mapProvider('google_places', jest.fn().mockResolvedValue({
      provider: 'google_places',
      results: [company('Places Capital', 'https://places-capital.example')],
      queriesRun: 2,
    }));
    const collect = jest.fn().mockResolvedValue({
      results: [],
      rejected: 0,
      providerError: 'Web search provider plan limit exceeded.',
      queriesRun: 8,
    });
    const { service, audit } = buildService({ chain: [osm, google], collect });

    const result = await service.discover('exec-l', 'org-l', texasPlan);
    expect(result.providerStatusSummary).toMatch(/OpenStreetMap — LOCATION RESOLUTION FAILED/);
    expect(result.providerStatusSummary).toMatch(/Google Places — COMPLETED/);
    expect(result.providerStatusSummary).toMatch(/Web Search — QUOTA EXCEEDED/);
    const discoveredAudit = audit.mock.calls.find((call) => call[2] === 'CANDIDATES_DISCOVERED');
    expect(discoveredAudit?.[4]).toMatchObject({
      providerStatusSummary: expect.stringContaining('Google Places — COMPLETED'),
      discoveryStatus: 'COMPLETED_WITH_SHORTFALL',
    });
  });

  it('M. Aggregate provider failure message is truthful', () => {
    const attempts: DiscoveryProviderAttempt[] = [
      {
        provider: 'web_search',
        outcome: 'QUOTA_EXCEEDED',
        message: 'Web search provider plan limit exceeded.',
        resultsCount: 0,
        queriesRun: 20,
        queriesSkipped: 580,
      },
      {
        provider: 'osm',
        outcome: 'LOCATION_RESOLUTION_FAILED',
        message: 'OpenStreetMap discovery could not resolve the search location.',
        resultsCount: 0,
        queriesRun: 1,
        queriesSkipped: 0,
      },
      {
        provider: 'google_places',
        outcome: 'CONFIGURATION_ERROR',
        message: 'Google Places provider is not configured.',
        resultsCount: 0,
        queriesRun: 0,
        queriesSkipped: 0,
      },
    ];
    expect(aggregateDiscoveryFailure(0, attempts)).toMatch(/Discovery failed because all configured providers were unavailable/);
    expect(aggregateDiscoveryFailure(0, attempts)).toMatch(/Web Search: quota exceeded/);
    expect(aggregateDiscoveryFailure(0, attempts)).toMatch(/OpenStreetMap: location resolution failed/);
    expect(aggregateDiscoveryFailure(0, attempts)).toMatch(/Google Places: configuration error/);
    expect(discoveryCompletedWithLimitationsMessage(87, 300, [
      ...attempts.slice(0, 2),
      { provider: 'google_places', outcome: 'SUCCESS', message: null, resultsCount: 87, queriesRun: 40, queriesSkipped: 0 },
    ])).toMatch(/Found 87 of 300 requested companies/);
  });

  it('N. Organization isolation for circuit state', () => {
    const orgA = new DiscoveryExecutionCircuit('exec-1', 'org-a');
    const orgB = new DiscoveryExecutionCircuit('exec-1', 'org-b');
    orgA.trip('web_search', 'QUOTA_EXCEEDED', 'quota');
    expect(orgA.isUnavailable('web_search')).toBe(true);
    expect(orgB.isUnavailable('web_search')).toBe(false);
  });

  it('O. Execution isolation for circuit state', () => {
    const exec1 = new DiscoveryExecutionCircuit('exec-1', 'org-a');
    const exec2 = new DiscoveryExecutionCircuit('exec-2', 'org-a');
    exec1.trip('osm', 'LOCATION_RESOLUTION_FAILED', 'unresolved');
    expect(exec1.isUnavailable('osm')).toBe(true);
    expect(exec2.isUnavailable('osm')).toBe(false);
  });

  it('UI failure: Web quota + OSM location fail → Google Places still used when configured', async () => {
    const placesCompany = company('Texas Nest Buyers', 'https://texasnest.example', 'San Antonio');
    const osmSearch = jest.fn().mockResolvedValue({
      provider: 'osm',
      results: [],
      providerError: 'OpenStreetMap discovery could not resolve the search location.',
      queriesRun: 1,
    });
    const googleSearch = jest.fn().mockResolvedValue({
      provider: 'google_places',
      results: [placesCompany],
      queriesRun: 6,
    });
    const osm = mapProvider('osm', osmSearch);
    const google = mapProvider('google_places', googleSearch);
    const collect = jest.fn().mockResolvedValue({
      results: [],
      rejected: 0,
      providerError: 'Web search provider plan limit exceeded.',
      queriesRun: 20,
    });
    const chain = discoveryMapProviderChain('development', 'osm', google, osm, mapProvider('fake', jest.fn()));
    expect(chain.map((p) => p.providerName())).toEqual(['osm', 'google_places']);
    const { service } = buildService({ chain, collect });

    await expect(service.discover('exec-ui', 'org-ui', texasPlan)).resolves.toMatchObject({
      candidates: 1,
      primaryError: 'OpenStreetMap discovery could not resolve the search location.',
      webError: 'Web search provider plan limit exceeded.',
    });
    expect(googleSearch).toHaveBeenCalled();
    expect(classifyDiscoveryProviderOutcome({
      resultsCount: 0,
      error: 'OpenStreetMap discovery could not resolve the search location.',
    })).toBe('LOCATION_RESOLUTION_FAILED');
    expect(classifyDiscoveryProviderOutcome({
      resultsCount: 0,
      error: 'Web search provider plan limit exceeded.',
    })).toBe('QUOTA_EXCEEDED');
  });

  it('preserves Texas location criteria on the SearchPlan (no silent city substitution)', async () => {
    const osmSearch = jest.fn().mockResolvedValue({
      provider: 'osm',
      results: [],
      providerError: 'OpenStreetMap discovery could not resolve the search location.',
      queriesRun: 1,
    });
    const googleSearch = jest.fn().mockResolvedValue({
      provider: 'google_places',
      results: [],
      queriesRun: 1,
    });
    const osm = mapProvider('osm', osmSearch);
    const google = mapProvider('google_places', googleSearch);
    const collect = jest.fn().mockResolvedValue({ results: [], rejected: 0, providerError: null, queriesRun: 1 });
    const { service } = buildService({ chain: [osm, google], collect });
    await service.discover('exec-tx', 'org-tx', texasPlan);
    expect(osmSearch).toHaveBeenCalledWith(expect.objectContaining({
      locations: [{ country: 'US', state: 'Texas' }],
    }), expect.any(Object));
    expect(googleSearch).toHaveBeenCalledWith(expect.objectContaining({
      locations: [{ country: 'US', state: 'Texas' }],
      searchIntent: expect.stringMatching(/cash home buyers|fix and flip|wholesaling/i),
      exclusions: expect.arrayContaining(['realtors', 'mortgage companies', 'property managers']),
    }), expect.any(Object));
  });

  it('progress summary counts providers without exposing secrets', () => {
    const summary = discoveryProgressSummary([
      {
        provider: 'web_search',
        outcome: 'QUOTA_EXCEEDED',
        message: 'Web search provider plan limit exceeded.',
        resultsCount: 0,
        queriesRun: 20,
        queriesSkipped: 580,
      },
      {
        provider: 'google_places',
        outcome: 'SUCCESS',
        message: null,
        resultsCount: 87,
        queriesRun: 40,
        queriesSkipped: 0,
      },
      {
        provider: 'osm',
        outcome: 'LOCATION_RESOLUTION_FAILED',
        message: 'OpenStreetMap discovery could not resolve the search location.',
        resultsCount: 0,
        queriesRun: 1,
        queriesSkipped: 0,
      },
    ]);
    expect(summary.providersAttempted).toBe(3);
    expect(summary.providersSucceeded).toBe(1);
    expect(summary.providersQuotaExceeded).toBe(1);
    expect(summary.queriesSkipped).toBe(580);
    expect(summary.providerStatusSummary).not.toMatch(/api[_-]?key|secret|bearer/i);
    expect(summary.providerStatusLines).toEqual([
      'Web Search — QUOTA EXCEEDED',
      'Google Places — COMPLETED',
      'OpenStreetMap — LOCATION RESOLUTION FAILED',
    ]);
  });
});
