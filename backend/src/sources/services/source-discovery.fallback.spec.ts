import { SourceProviderError } from '../providers/source-provider.error';
import type { NormalizedSourceResult, SourceProvider } from '../types/source.types';
import type { SearchPlan } from '../../search/types/search-plan.types';
import { SourceDiscoveryService } from './source-discovery.service';

const plan: SearchPlan = {
  industry: ['software'],
  leadTypes: [],
  locations: [{ country: 'US', state: 'California' }],
  companyFields: [],
  maxResults: 10,
  requestedCount: 10,
  unresolvedCriteria: [],
};

function company(name: string, website: string, city = 'San Francisco'): NormalizedSourceResult {
  return {
    externalId: `web:${website}`,
    name,
    website,
    sourceUrl: website,
    address: { city, state: 'California', country: 'US' },
  };
}

function buildService(input: {
  searchBusinesses: SourceProvider['searchBusinesses'];
  collect?: jest.Mock;
  chain?: SourceProvider[];
}) {
  const provider = {
    providerName: () => 'osm',
    getSourceType: () => 'osm',
    metadata: () => ({ provider: 'osm', sourceType: 'osm', synthetic: false }),
    searchBusinesses: input.searchBusinesses,
    health: () => ({ name: 'osm', configured: true, enabled: true }),
  } as unknown as SourceProvider;
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
    collect: input.collect ?? jest.fn().mockResolvedValue({ results: [], rejected: 0, providerError: null }),
  };
  const config = {
    get: (_key: string, fallback?: unknown) => {
      if (_key === 'webSearch.tavilyApiKey') return 'test-key';
      if (_key === 'webSearch.provider') return 'tavily';
      return fallback ?? 4;
    },
  };
  const service = new SourceDiscoveryService(
    {} as never,
    provider,
    input.chain ?? [provider],
    { normalize: (value: NormalizedSourceResult) => value } as never,
    usage as never,
    providerObservability as never,
    requestContext as never,
    webDiscovery as never,
    config as never,
    { warn: jest.fn(), info: jest.fn(), error: jest.fn() } as never,
  );
  jest.spyOn(service as never as { audit: (...args: unknown[]) => Promise<void> }, 'audit').mockResolvedValue(undefined);
  jest.spyOn(service as never as { persistResults: (...args: unknown[]) => Promise<number> }, 'persistResults')
    .mockImplementation(async (_organizationId, _executionId, _provider, results: NormalizedSourceResult[]) => results.length);
  return { service, webDiscovery, usage, providerObservability };
}

describe('SourceDiscoveryService OSM web fallback', () => {
  it('continues with web discovery when OpenStreetMap returns a rate-limit providerError', async () => {
    const webCompany = company('Bay Soft Labs', 'https://baysoft.example');
    let calls = 0;
    const collect = jest.fn()
      .mockImplementation(async (_plan, _need, _exclude, _round, stream?: { onBatch?: (batch: NormalizedSourceResult[]) => Promise<void> }) => {
        calls += 1;
        if (calls > 1) return { results: [], rejected: 0, providerError: null, queriesRun: 0 };
        if (stream?.onBatch) await stream.onBatch([webCompany]);
        return { results: [webCompany], rejected: 0, providerError: null, queriesRun: 1 };
      });
    const { service, webDiscovery } = buildService({
      searchBusinesses: jest.fn().mockResolvedValue({
        provider: 'osm',
        results: [],
        providerError: 'OpenStreetMap provider rate limit reached.',
      }),
      collect,
    });

    await expect(service.discover('exec-1', 'org-1', plan)).resolves.toMatchObject({ candidates: 1 });
    expect(webDiscovery.collect).toHaveBeenNthCalledWith(
      1,
      plan,
      10,
      [],
      0,
      expect.objectContaining({ onBatch: expect.any(Function) }),
    );
  });

  it('continues with web discovery when OpenStreetMap throws a recoverable rate-limit error', async () => {
    const webCompany = company('Pacific Apps', 'https://pacificapps.example', 'Los Angeles');
    let calls = 0;
    const collect = jest.fn()
      .mockImplementation(async (_plan, _need, _exclude, _round, stream?: { onBatch?: (batch: NormalizedSourceResult[]) => Promise<void> }) => {
        calls += 1;
        if (calls > 1) return { results: [], rejected: 0, providerError: null, queriesRun: 0 };
        if (stream?.onBatch) await stream.onBatch([webCompany]);
        return { results: [webCompany], rejected: 0, providerError: null, queriesRun: 1 };
      });
    const { service, webDiscovery } = buildService({
      searchBusinesses: jest.fn().mockRejectedValue(
        new SourceProviderError('PROVIDER_RATE_LIMITED', 'OpenStreetMap provider rate limit reached.'),
      ),
      collect,
    });

    await expect(service.discover('exec-2', 'org-1', plan)).resolves.toMatchObject({ candidates: 1 });
    expect(webDiscovery.collect).toHaveBeenNthCalledWith(
      1,
      plan,
      10,
      [],
      0,
      expect.objectContaining({ onBatch: expect.any(Function) }),
    );
  });

  it('keeps partial OpenStreetMap results and asks web discovery for the remaining count', async () => {
    const osmCompany = company('Coast Code', 'https://coastcode.example', 'San Diego');
    const webCompany = company('Valley Systems', 'https://valleysystems.example', 'San Jose');
    let calls = 0;
    const collect = jest.fn()
      .mockImplementation(async (_plan, _need, _exclude, _round, stream?: { onBatch?: (batch: NormalizedSourceResult[]) => Promise<void> }) => {
        calls += 1;
        if (calls > 1) return { results: [], rejected: 0, providerError: null, queriesRun: 0 };
        if (stream?.onBatch) await stream.onBatch([webCompany]);
        return { results: [webCompany, osmCompany], rejected: 0, providerError: null, queriesRun: 1 };
      });
    const { service, webDiscovery } = buildService({
      searchBusinesses: jest.fn().mockResolvedValue({
        provider: 'osm',
        results: [osmCompany],
        providerError: 'OpenStreetMap provider rate limit reached.',
      }),
      collect,
    });

    await expect(service.discover('exec-3', 'org-1', plan)).resolves.toMatchObject({ candidates: 2 });
    expect(webDiscovery.collect).toHaveBeenNthCalledWith(
      1,
      plan,
      9,
      [osmCompany],
      0,
      expect.objectContaining({ onBatch: expect.any(Function) }),
    );
  });

  it('fails with a clear provider failure when OSM and web both fail', async () => {
    const { service } = buildService({
      searchBusinesses: jest.fn().mockResolvedValue({
        provider: 'osm',
        results: [],
        providerError: 'OpenStreetMap provider rate limit reached.',
      }),
      collect: jest.fn().mockResolvedValue({
        results: [],
        rejected: 0,
        providerError: 'Web search provider plan limit exceeded.',
      }),
    });

    await expect(service.discover('exec-4', 'org-1', plan)).rejects.toMatchObject({
      code: 'PROVIDER_QUOTA_EXCEEDED',
      message: expect.stringMatching(/Discovery failed because all configured providers were unavailable[\s\S]*OpenStreetMap[\s\S]*(plan limit|quota)/i),
    });
  });
});
