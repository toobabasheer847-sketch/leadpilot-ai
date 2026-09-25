import { ConfigService } from '@nestjs/config';
import { OutboundRequestError, OutboundRequestService } from '../../../common/outbound-request.service';
import { SourceNormalizerService } from '../../services/source-normalizer.service';
import { OsmSourceProvider } from './osm.provider';

const plan = {
  industry: ['legal'],
  leadTypes: [],
  locations: [{ country: 'US', state: 'Florida' }],
  companyFields: [],
  unresolvedCriteria: [],
};

const context = { organizationId: 'org-1', searchExecutionId: 'execution-1' };

const taggedElement = {
  type: 'node',
  id: 42,
  lat: 25.76,
  lon: -80.19,
  tags: {
    name: 'Coast Counsel',
    office: 'lawyer',
    website: 'HTTPS://COAST.EXAMPLE/path/',
    phone: '+1 (305) 555-0100',
    email: 'Office@Coast.Example',
    'addr:housenumber': '10',
    'addr:street': 'Biscayne Blvd',
    'addr:city': 'Miami',
    'addr:state': 'Florida',
    'addr:postcode': '33131',
    'addr:country': 'US',
    description: 'Email hidden in prose office@not-a-tag.example',
  },
};

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

function geocodeResponse() {
  return httpResponse([{ boundingbox: ['25.700000', '25.900000', '-80.300000', '-80.100000'] }]);
}

function providerWith(response: unknown, status = 200, overrides: Record<string, unknown> = {}, fetchImpl?: jest.Mock) {
  const fetch = fetchImpl ?? jest.fn()
    .mockResolvedValueOnce(geocodeResponse())
    .mockResolvedValue(httpResponse(response, status));
  const outbound = { fetch } as unknown as OutboundRequestService;
  const values: Record<string, unknown> = {
    'sourceProvider.overpassApiUrl': 'https://overpass.example/api/interpreter',
    'sourceProvider.nominatimApiUrl': 'https://geocode.example/search',
    'sourceProvider.overpassTimeoutMs': 30000,
    'sourceProvider.overpassMaxResults': 20,
    'sourceProvider.retries': 0,
    'sourceProvider.retryDelayMs': 0,
    'sourceProvider.retainRawData': true,
    ...overrides,
  };
  const config = { get: (key: string) => values[key] } as ConfigService;
  return { provider: new OsmSourceProvider(outbound, new SourceNormalizerService(), config), outbound, fetch };
}

describe('OsmSourceProvider', () => {
  it('reports configuration without exposing credentials', () => {
    const { provider } = providerWith({ elements: [] });
    expect(provider.health()).toEqual({ name: 'osm', configured: true, enabled: true });
    expect(provider.providerName()).toBe('osm');
    expect(provider.getSourceType()).toBe('osm');
    expect(provider.metadata()).toEqual({ provider: 'osm', sourceType: 'osm', synthetic: false });
    expect(JSON.stringify(provider.health())).not.toContain('overpass.example');
  });

  it('normalizes an Overpass element and preserves provenance', async () => {
    const { provider, fetch } = providerWith({ elements: [taggedElement] });

    const result = await provider.searchBusinesses(plan, context);

    expect(String(fetch.mock.calls[0]?.[0])).toContain('https://geocode.example/search');
    expect(String(fetch.mock.calls[0]?.[0])).toContain('Florida');
    expect(fetch).toHaveBeenCalledWith(
      'https://overpass.example/api/interpreter',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining(encodeURIComponent('["office"="lawyer"]')),
      }),
      30000,
    );
    expect(result).toMatchObject({
      provider: 'osm',
      results: [{
        externalId: 'node/42',
        name: 'Coast Counsel',
        website: 'https://coast.example/path',
        phone: '+13055550100',
        email: 'office@coast.example',
        category: 'lawyer',
        sourceUrl: 'https://www.openstreetmap.org/node/42',
        address: {
          addressLine1: '10 Biscayne Blvd',
          city: 'Miami',
          state: 'Florida',
          postalCode: '33131',
          country: 'US',
          latitude: 25.76,
          longitude: -80.19,
        },
      }],
    });
    expect(result.results[0]?.rawData).toEqual(expect.objectContaining({
      provider: 'osm',
      source: 'openstreetmap',
      osmType: 'node',
      osmId: 42,
    }));
    expect(JSON.stringify(result.results[0]?.rawData)).not.toContain('not-a-tag.example');
  });

  it('does not fabricate website, phone, or email when OSM did not provide them', () => {
    const { provider } = providerWith({ elements: [] });
    const result = provider.normalizeResult({
      type: 'way',
      id: 7,
      center: { lat: 30.1, lon: -97.7 },
      tags: { name: 'Unlisted Office', office: 'lawyer', description: 'call 555-0100 or email owner@guessed.example' },
    });

    expect(result.website).toBeUndefined();
    expect(result.phone).toBeUndefined();
    expect(result.email).toBeUndefined();
    expect(result.sourceUrl).toBe('https://www.openstreetmap.org/way/7');
    expect(result.externalId).toBe('way/7');
    expect(result.address).toEqual({ latitude: 30.1, longitude: -97.7 });
  });

  it('returns an empty result for an empty Overpass response', async () => {
    const { provider } = providerWith({ elements: [] });
    await expect(provider.searchBusinesses(plan, context)).resolves.toEqual({ provider: 'osm', results: [] });
  });

  it('rejects a malformed Overpass response', async () => {
    await expect(providerWith({ elements: { node: 1 } }).provider.searchBusinesses(plan, context)).rejects.toMatchObject({ code: 'PROVIDER_UNKNOWN_ERROR' });
    await expect(providerWith({ remark: 'parse error: unexpected token' }).provider.searchBusinesses(plan, context)).rejects.toMatchObject({ code: 'PROVIDER_INVALID_REQUEST' });
    const { provider } = providerWith({ elements: [] });
    expect(() => provider.normalizeResult({ type: 'node', id: 1, tags: {} })).toThrow(/required provenance/);
  });

  it('maps timeouts, HTTP 429, and HTTP 5xx without retrying rate limits', async () => {
    const timeoutFetch = jest.fn()
      .mockResolvedValueOnce(geocodeResponse())
      .mockRejectedValueOnce(new OutboundRequestError('Outbound request timed out'));
    await expect(providerWith({}, 200, {}, timeoutFetch).provider.searchBusinesses(plan, context)).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });
    expect(timeoutFetch).toHaveBeenCalledTimes(2);

    const limited = jest.fn()
      .mockResolvedValueOnce(geocodeResponse())
      .mockResolvedValueOnce(httpResponse({ remark: 'rate limited' }, 429));
    await expect(providerWith({}, 429, { 'sourceProvider.retries': 2 }, limited).provider.searchBusinesses(plan, context)).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMITED' });
    expect(limited).toHaveBeenCalledTimes(2);

    const unavailable = jest.fn()
      .mockResolvedValueOnce(geocodeResponse())
      .mockResolvedValueOnce(httpResponse({ remark: 'bad gateway' }, 502))
      .mockResolvedValueOnce(httpResponse({ elements: [] }, 200));
    const recovered = providerWith({}, 502, { 'sourceProvider.retries': 1 }, unavailable);
    await expect(recovered.provider.searchBusinesses(plan, context)).resolves.toEqual({ provider: 'osm', results: [] });
    expect(unavailable).toHaveBeenCalledTimes(3);

    await expect(providerWith({ remark: 'server error' }, 503).provider.searchBusinesses(plan, context)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });

  it('respects the configured result limit and collapses duplicate businesses', async () => {
    const elements = [
      { type: 'node', id: 1, tags: { name: 'Alpha Realty', office: 'estate_agent', website: 'https://alpha.example' } },
      { type: 'way', id: 2, tags: { name: 'Alpha Realty Duplicate', office: 'estate_agent', website: 'https://alpha.example/' } },
      { type: 'node', id: 3, tags: { name: 'Beta Realty', office: 'estate_agent' } },
    ];
    const { provider, fetch } = providerWith({ elements }, 200, { 'sourceProvider.overpassMaxResults': 2 });

    const result = await provider.searchBusinesses({
      industry: ['real_estate'],
      leadTypes: [],
      locations: [{ country: 'US', state: 'Texas' }],
      companyFields: [],
      unresolvedCriteria: [],
    }, context);

    expect(result.results).toHaveLength(2);
    expect(result.results.map((item) => item.externalId)).toEqual(['node/1', 'node/3']);
    expect(result.results.every((item) => item.email === undefined)).toBe(true);
    expect(String(fetch.mock.calls[0]?.[0])).toContain('Texas');
    const body = String(fetch.mock.calls[1]?.[1]?.body);
    expect(decodeURIComponent(body)).toContain('out center 2;');
    expect(decodeURIComponent(body)).toContain('["office"="estate_agent"]');
    expect(decodeURIComponent(body)).not.toContain('Texas');
  });

  it('does not send an unsafe location to either service', async () => {
    const { provider, fetch } = providerWith({ elements: [] });
    await expect(provider.searchBusinesses({
      industry: ['legal'],
      leadTypes: [],
      locations: [{ country: 'US', state: 'Florida"; out;' }],
      companyFields: [],
      unresolvedCriteria: [],
    }, context)).rejects.toMatchObject({ code: 'PROVIDER_INVALID_REQUEST' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not call Overpass when the endpoint is not https', async () => {
    const { provider, fetch } = providerWith({ elements: [] }, 200, { 'sourceProvider.overpassApiUrl': 'http://overpass.example/api' });
    expect(provider.health().configured).toBe(false);
    await expect(provider.searchBusinesses(plan, context)).rejects.toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED' });
    expect(fetch).not.toHaveBeenCalled();
  });
});
