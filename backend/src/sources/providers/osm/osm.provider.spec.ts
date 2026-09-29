import { ConfigService } from '@nestjs/config';
import { OutboundRequestError, OutboundRequestService } from '../../../common/outbound-request.service';
import { SourceNormalizerService } from '../../services/source-normalizer.service';
import { OsmSourceProvider } from './osm.provider';
import { searchWindows } from './overpass.query-builder';

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
    'sourceProvider.discoveryQueryConcurrency': 1,
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
    await expect(provider.searchBusinesses(plan, context)).resolves.toEqual({
      provider: 'osm',
      results: [],
      duplicatesRemoved: 0,
      rejectedCandidates: 0,
      queriesRun: 2,
    });
  });

  it('rejects a malformed Overpass response', async () => {
    await expect(providerWith({ elements: { node: 1 } }).provider.searchBusinesses(plan, context)).rejects.toMatchObject({ code: 'PROVIDER_UNKNOWN_ERROR' });
    const rejected = await providerWith({ remark: 'parse error: unexpected token' }).provider.searchBusinesses(plan, context);
    expect(rejected.results).toEqual([]);
    expect(rejected.providerError).toMatch(/rejected the search request/i);
    const { provider } = providerWith({ elements: [] });
    expect(() => provider.normalizeResult({ type: 'node', id: 1, tags: {} })).toThrow(/required provenance/);
  });

  it('keeps partial OpenStreetMap results when a later request is rate limited', async () => {
    const limited = jest.fn()
      .mockResolvedValueOnce(geocodeResponse())
      .mockResolvedValueOnce(httpResponse({ elements: [taggedElement] }))
      .mockResolvedValueOnce(httpResponse({ remark: 'rate limited' }, 429));
    const result = await providerWith({}, 200, {}, limited).provider.searchBusinesses({
      ...plan,
      locations: [
        { country: 'US', state: 'Florida', city: 'Miami' },
        { country: 'US', state: 'Florida', city: 'Tampa' },
      ],
    }, context);
    expect(result.results.map((company) => company.name)).toEqual(['Coast Counsel']);
    expect(result.providerError).toMatch(/rate limit/i);
    expect(limited).toHaveBeenCalledTimes(3);
  });

  it('maps timeouts, HTTP 429, and HTTP 5xx without retrying rate limits', async () => {
    const timeoutFetch = jest.fn()
      .mockResolvedValueOnce(geocodeResponse())
      .mockRejectedValueOnce(new OutboundRequestError('Outbound request timed out'));
    const timedOut = await providerWith({}, 200, {}, timeoutFetch).provider.searchBusinesses(plan, context);
    expect(timedOut.results).toEqual([]);
    expect(timedOut.providerError).toMatch(/timed out/i);
    expect(timeoutFetch).toHaveBeenCalledTimes(2);

    const limited = jest.fn()
      .mockResolvedValueOnce(geocodeResponse())
      .mockResolvedValueOnce(httpResponse({ remark: 'rate limited' }, 429));
    const rateLimited = await providerWith({}, 429, { 'sourceProvider.retries': 2 }, limited).provider.searchBusinesses(plan, context);
    expect(rateLimited.results).toEqual([]);
    expect(rateLimited.providerError).toMatch(/rate limit/i);
    expect(limited).toHaveBeenCalledTimes(2);

    const unavailable = jest.fn()
      .mockResolvedValueOnce(geocodeResponse())
      .mockResolvedValueOnce(httpResponse({ remark: 'bad gateway' }, 502))
      .mockResolvedValueOnce(httpResponse({ elements: [] }, 200));
    const recovered = providerWith({}, 502, { 'sourceProvider.retries': 1 }, unavailable);
    await expect(recovered.provider.searchBusinesses(plan, context)).resolves.toEqual({
      provider: 'osm',
      results: [],
      duplicatesRemoved: 0,
      rejectedCandidates: 0,
      queriesRun: 2,
    });
    expect(unavailable).toHaveBeenCalledTimes(3);

    const down = await providerWith({ remark: 'server error' }, 503).provider.searchBusinesses(plan, context);
    expect(down.results).toEqual([]);
    expect(down.providerError).toMatch(/unavailable/i);
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
    const result = await provider.searchBusinesses({
      industry: ['legal'],
      leadTypes: [],
      locations: [{ country: 'US', state: 'Florida"; out;' }],
      companyFields: [],
      unresolvedCriteria: [],
    }, context);
    expect(result.results).toEqual([]);
    expect(result.providerError).toMatch(/unsupported location value/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('covers Texas with bounded partitions, drops excluded businesses, and keeps source evidence', async () => {
    const texasBox = { south: 25.83706, west: -106.645846, north: 36.500453, east: -93.507822 };
    const windows = searchWindows(texasBox);
    const elements = [
      { type: 'node', id: 1, lat: 30.27, lon: -97.74, tags: { name: 'Trinity Investments', office: 'company', 'addr:city': 'Austin', 'addr:state': 'Texas', 'addr:postcode': '78701', 'addr:country': 'US' } },
      { type: 'node', id: 2, lat: 30.27, lon: -97.74, tags: { name: 'trinity investments', office: 'company', 'addr:city': 'Austin', 'addr:state': 'Texas' } },
      { type: 'node', id: 3, lat: 29.76, lon: -95.37, tags: { name: 'Oak Stream Investors', office: 'company', 'addr:city': 'Houston', 'addr:state': 'Texas' } },
      { type: 'node', id: 4, lat: 29.42, lon: -98.49, tags: { name: 'Oak Stream Investor Group', office: 'company', 'addr:city': 'San Antonio', 'addr:state': 'Texas' } },
      { type: 'node', id: 5, tags: { name: 'Austin Realty Investments', office: 'estate_agent', 'addr:city': 'Austin', 'addr:state': 'Texas' } },
      { type: 'node', id: 6, tags: { name: 'Hill Country Brokerage', office: 'company' } },
      { type: 'node', id: 7, tags: { name: 'Metro Realtor Group', office: 'estate_agent' } },
      { type: 'node', id: 8, tags: { name: 'Capital Mortgage Lender', office: 'financial' } },
      { type: 'node', id: 9, tags: { name: 'Lone Star Title Company', office: 'company' } },
      { type: 'node', id: 19, lat: 36.1, lon: -95.9, tags: { name: 'Cavalry Investments', office: 'company', 'addr:city': 'Tulsa', 'addr:state': 'OK' } },
      { type: 'node', id: 20, lat: 36.0521, lon: -95.7917, tags: { name: 'Broken Arrow Investments', office: 'company' } },
      { type: 'node', id: 21, lat: 32.78, lon: -96.8, tags: { name: 'Holdings Without Address', office: 'company' } },
      { type: 'node', id: 10, lat: 32.78, lon: -96.8, tags: { name: 'Holdings Without Address', office: 'company' } },
    ];
    const fetch = jest.fn()
      .mockResolvedValueOnce(httpResponse([{ boundingbox: [String(texasBox.south), String(texasBox.north), String(texasBox.west), String(texasBox.east)] }]))
      .mockResolvedValue(httpResponse({ elements }));
    const { provider } = providerWith({ elements: [] }, 200, { 'sourceProvider.overpassMaxResults': 50, 'sourceProvider.retryDelayMs': 0, 'sourceProvider.discoveryQueryConcurrency': 2 }, fetch);

    const result = await provider.searchBusinesses({
      industry: ['real_estate'],
      leadTypes: ['real_estate_investor'],
      locations: [{ country: 'US', state: 'Texas' }],
      companyFields: [],
      companySize: { min: 1, max: 50 },
      maxResults: 50,
      unresolvedCriteria: [],
    }, context);

    expect(fetch).toHaveBeenCalledTimes(1 + windows.length);
    expect(windows.length).toBeGreaterThan(3);
    const query = decodeURIComponent(String(fetch.mock.calls[1]?.[1]?.body));
    expect(query).toContain('investor|investment|acquisition|holdings');
    expect(query).not.toContain('["office"="estate_agent"]');
    expect(query).not.toContain('Texas');
    expect(result.results.map((item) => item.name).sort()).toEqual([
      'Holdings Without Address',
      'Oak Stream Investor Group',
      'Oak Stream Investors',
      'Trinity Investments',
    ]);
    const trinity = result.results.find((item) => item.externalId === 'node/1');
    expect(trinity).toMatchObject({
      sourceUrl: 'https://www.openstreetmap.org/node/1',
      address: { city: 'Austin', state: 'Texas', postalCode: '78701', country: 'US' },
    });
    expect(trinity?.rawData).toEqual(expect.objectContaining({ provider: 'osm', osmType: 'node', osmId: 1 }));
    expect(trinity).not.toHaveProperty('employeeCount');
    const unlisted = result.results.find((item) => item.externalId === 'node/10');
    expect(unlisted?.website).toBeUndefined();
    expect(unlisted?.phone).toBeUndefined();
    expect(unlisted?.email).toBeUndefined();
    expect(unlisted?.address?.addressLine1).toBeUndefined();
    expect(unlisted?.address?.city).toBeUndefined();
    expect(unlisted?.address?.state).toBeUndefined();
    expect(unlisted?.address?.postalCode).toBeUndefined();
    expect(unlisted?.address?.country).toBeUndefined();
    expect(result.results.every((item) => !/realty|brokerage|realtor|mortgage|title company/i.test(item.name))).toBe(true);
    expect(result.results.some((item) => item.name === 'Broken Arrow Investments')).toBe(false);
    expect(result.results.filter((item) => item.name === 'Holdings Without Address')).toHaveLength(1);
    expect(result.duplicatesRemoved).toBeGreaterThan(0);
    expect(result.rejectedCandidates).toBeGreaterThan(0);
  });

  it('stops at the requested maximum instead of returning every partition hit', async () => {
    const texasBox = { south: 25.83706, west: -106.645846, north: 36.500453, east: -93.507822 };
    const elements = [1, 2, 3].map((id) => ({
      type: 'node',
      id,
      lat: 30 + id,
      lon: -97,
      tags: { name: `Investor Office ${id}`, office: 'company', 'addr:city': `City ${id}`, 'addr:state': 'Texas' },
    }));
    const fetch = jest.fn()
      .mockResolvedValueOnce(httpResponse([{ boundingbox: [String(texasBox.south), String(texasBox.north), String(texasBox.west), String(texasBox.east)] }]))
      .mockResolvedValue(httpResponse({ elements }));
    const { provider } = providerWith({ elements: [] }, 200, { 'sourceProvider.overpassMaxResults': 50 }, fetch);
    const result = await provider.searchBusinesses({
      industry: ['real_estate'],
      leadTypes: ['real_estate_investor'],
      locations: [{ country: 'US', state: 'Texas' }],
      companyFields: [],
      maxResults: 2,
      unresolvedCriteria: [],
    }, context);

    expect(result.results).toHaveLength(2);
    expect(decodeURIComponent(String(fetch.mock.calls[1]?.[1]?.body))).toContain('out center 2;');
  });

  it('does not call Overpass when the endpoint is not https', async () => {
    const { provider, fetch } = providerWith({ elements: [] }, 200, { 'sourceProvider.overpassApiUrl': 'http://overpass.example/api' });
    expect(provider.health().configured).toBe(false);
    await expect(provider.searchBusinesses(plan, context)).rejects.toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED' });
    expect(fetch).not.toHaveBeenCalled();
  });
});
