import { ConfigService } from '@nestjs/config';
import { OutboundRequestError, OutboundRequestService } from '../../../common/outbound-request.service';
import { GooglePlacesProvider } from './google-places.provider';

const plan = {
  industry: ['software'],
  leadTypes: [],
  locations: [{ country: 'US', state: 'California' }],
  companyFields: [],
  unresolvedCriteria: [],
};

const context = { organizationId: 'org-1', searchExecutionId: 'execution-1' };

function httpResponse(body: unknown, status = 200) {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
    text: jest.fn().mockResolvedValue(text),
    clone() { return this; },
  };
}

function providerWith(response: unknown, status = 200, overrides: Record<string, unknown> = {}) {
  const outbound = { fetch: jest.fn().mockResolvedValue(httpResponse(response, status)) } as unknown as OutboundRequestService;
  const values: Record<string, unknown> = {
    'sourceProvider.googlePlacesApiKey': 'configured-key',
    'sourceProvider.googlePlacesBaseUrl': 'https://provider.test/search',
    'sourceProvider.maxResults': 20,
    'sourceProvider.pageSize': 20,
    'sourceProvider.timeoutMs': 1000,
    'sourceProvider.retries': 0,
    'sourceProvider.retryDelayMs': 0,
    'sourceProvider.retainRawData': true,
    ...overrides,
  };
  const config = { get: (key: string) => values[key] } as ConfigService;
  return { provider: new GooglePlacesProvider(outbound, config), outbound };
}

describe('GooglePlacesProvider', () => {
  it('reports configuration without exposing the API key', () => {
    const { provider } = providerWith({ places: [] });
    expect(provider.health()).toEqual({ name: 'google_places', configured: true, enabled: true });
    expect(provider.providerName()).toBe('google_places');
    expect(JSON.stringify(provider.health())).not.toContain('configured-key');
  });

  it('uses the configured endpoint and returns normalized provider facts', async () => {
    const { provider, outbound } = providerWith({ places: [{ id: 'place-1', displayName: { text: 'Real Company' }, googleMapsUri: 'https://maps.google.com/?place=place-1', addressComponents: [{ longText: 'California', types: ['administrative_area_level_1'] }] }] });

    const result = await provider.searchBusinesses(plan, context);

    const fetchMock = (outbound as unknown as { fetch: jest.Mock }).fetch;
    expect(fetchMock).toHaveBeenCalledWith('https://provider.test/search', expect.objectContaining({ method: 'POST', body: expect.stringContaining('"pageSize":20') }), 1000);
    expect(result).toMatchObject({ provider: 'google_places', results: [{ externalId: 'place-1', name: 'Real Company', sourceUrl: 'https://maps.google.com/?place=place-1' }] });
    expect(result.results[0]?.rawData).toEqual(expect.objectContaining({ provider: 'google_places' }));
  });

  it('stops pagination at the configured result limit', async () => {
    const outbound = {
      fetch: jest.fn()
        .mockResolvedValueOnce(httpResponse({ places: [{ id: 'place-1', displayName: { text: 'One' }, googleMapsUri: 'https://maps.google.com/?place=place-1' }], nextPageToken: 'next' }))
        .mockResolvedValueOnce(httpResponse({ places: [{ id: 'place-2', displayName: { text: 'Two' }, googleMapsUri: 'https://maps.google.com/?place=place-2' }], nextPageToken: 'later' })),
    } as unknown as OutboundRequestService;
    const config = { get: (key: string) => ({ 'sourceProvider.googlePlacesApiKey': 'configured-key', 'sourceProvider.googlePlacesBaseUrl': 'https://provider.test/search', 'sourceProvider.maxResults': 2, 'sourceProvider.pageSize': 1, 'sourceProvider.timeoutMs': 1000, 'sourceProvider.retries': 0, 'sourceProvider.retryDelayMs': 0 }[key]) } as ConfigService;
    const provider = new GooglePlacesProvider(outbound, config);

    const result = await provider.searchBusinesses(plan, context);

    expect(result.results.map((item) => item.externalId)).toEqual(['place-1', 'place-2']);
    expect((outbound as unknown as { fetch: jest.Mock }).fetch).toHaveBeenCalledTimes(2);
  });

  it('does not call the provider or invent companies when the API key is missing', async () => {
    const { provider, outbound } = providerWith({ places: [] }, 200, { 'sourceProvider.googlePlacesApiKey': undefined });
    expect(provider.health().configured).toBe(false);
    await expect(provider.searchBusinesses(plan, context)).rejects.toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED' });
    expect((outbound as unknown as { fetch: jest.Mock }).fetch).not.toHaveBeenCalled();
  });

  it('maps rate limits, quota, authentication, and timeouts without exposing credentials', async () => {
    await expect(providerWith({ error: { status: 'RESOURCE_EXHAUSTED' } }, 429).provider.searchBusinesses(plan, context)).rejects.toMatchObject({ code: 'PROVIDER_QUOTA_EXCEEDED' });
    await expect(providerWith({ error: 'busy' }, 429).provider.searchBusinesses(plan, context)).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMITED' });
    await expect(providerWith({}, 401).provider.searchBusinesses(plan, context)).rejects.toMatchObject({ code: 'PROVIDER_AUTH_ERROR' });
    const outbound = { fetch: jest.fn().mockRejectedValue(new OutboundRequestError('Outbound request timed out')) } as unknown as OutboundRequestService;
    const config = { get: (key: string) => ({ 'sourceProvider.googlePlacesApiKey': 'configured-key', 'sourceProvider.googlePlacesBaseUrl': 'https://provider.test/search', 'sourceProvider.retries': 0, 'sourceProvider.retryDelayMs': 0, 'sourceProvider.timeoutMs': 1000, 'sourceProvider.maxResults': 1, 'sourceProvider.pageSize': 1 }[key]) } as ConfigService;
    await expect(new GooglePlacesProvider(outbound, config).searchBusinesses(plan, context)).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });
  });

  it('rejects malformed provider payloads and incomplete places', async () => {
    await expect(providerWith({ places: 'not-an-array' }).provider.searchBusinesses(plan, context)).rejects.toMatchObject({ code: 'PROVIDER_UNKNOWN_ERROR' });
    const { provider } = providerWith({ places: [] });
    expect(() => provider.normalizeResult({ displayName: { text: 'Missing provenance' } })).toThrow(/required provenance/);
  });
});
