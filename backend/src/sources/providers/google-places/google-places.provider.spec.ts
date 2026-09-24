import { ConfigService } from '@nestjs/config';
import { OutboundRequestService } from '../../../common/outbound-request.service';
import { GooglePlacesProvider } from './google-places.provider';

const plan = {
  industry: ['software'],
  leadTypes: [],
  locations: [{ country: 'US', state: 'California' }],
  companyFields: [],
  unresolvedCriteria: [],
};

function providerWith(response: unknown, status = 200) {
  const outbound = { fetch: jest.fn().mockResolvedValue({ ok: status >= 200 && status < 300, status, json: jest.fn().mockResolvedValue(response) }) } as unknown as OutboundRequestService;
  const config = { get: (key: string) => ({ 'sourceProvider.googlePlacesApiKey': 'configured-key', 'sourceProvider.googlePlacesBaseUrl': 'https://provider.test/search', 'sourceProvider.maxPages': 1, 'sourceProvider.timeoutMs': 1000 }[key]) } as ConfigService;
  return { provider: new GooglePlacesProvider(outbound, config), outbound };
}

describe('GooglePlacesProvider', () => {
  it('uses the configured endpoint and returns normalized provider facts', async () => {
    const { provider, outbound } = providerWith({ places: [{ id: 'place-1', displayName: { text: 'Real Company' }, googleMapsUri: 'https://maps.google.com/?place=place-1', addressComponents: [{ longText: 'California', types: ['administrative_area_level_1'] }] }] });

    const result = await provider.search(plan, { organizationId: 'org-1', searchExecutionId: 'execution-1' });

    const fetchMock = (outbound as unknown as { fetch: jest.Mock }).fetch;
    expect(fetchMock).toHaveBeenCalledWith('https://provider.test/search', expect.objectContaining({ method: 'POST' }), 1000);
    expect(result).toMatchObject({ provider: 'google_places', results: [{ externalId: 'place-1', name: 'Real Company', sourceUrl: 'https://maps.google.com/?place=place-1' }] });
    expect(provider.getSourceType()).toBe('google_places');
  });

  it('maps provider quota failures without exposing credentials', async () => {
    const { provider } = providerWith({ error: 'rate limited' }, 429);

    await expect(provider.search(plan, { organizationId: 'org-1', searchExecutionId: 'execution-1' })).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('rejects malformed provider payloads', async () => {
    const { provider } = providerWith({ places: 'not-an-array' });

    await expect(provider.search(plan, { organizationId: 'org-1', searchExecutionId: 'execution-1' })).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' });
  });
});