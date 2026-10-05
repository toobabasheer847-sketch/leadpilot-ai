import { ConfigService } from '@nestjs/config';
import { OutboundRequestError, OutboundRequestService } from '../../../common/outbound-request.service';
import type { SearchPlan } from '../../../search/types/search-plan.types';
import { OpenRouterDiscoveryProvider } from './openrouter-discovery.provider';
import { SourceProviderError } from '../source-provider.error';

const plan: SearchPlan = {
  industry: ['real_estate_investor'],
  leadTypes: ['cash_home_buyer', 'fix_and_flip', 'wholesaler'],
  locations: [{ country: 'US', state: 'Texas' }],
  companyFields: [],
  unresolvedCriteria: [],
  requestedCount: 1,
  maxResults: 1,
  searchIntent: 'Find a Texas real estate investor',
  originalPrompt: 'Find 100 real estate investor leads in Texas.',
};
const context = { organizationId: 'org-1', searchExecutionId: 'execution-1' };

const officialUrl = 'https://lonestarbuyers.example/';
const evidenceUrl = 'https://lonestarbuyers.example/texas-cash-buyers';
const company = {
  company_name: 'Lone Star Cash Home Buyers',
  official_website: officialUrl,
  evidence_url: evidenceUrl,
  contacts: [{
    full_name: 'Jordan Marks',
    title: 'Founder',
    email: 'jordan@lonestarbuyers.example',
    evidence_url: evidenceUrl,
  }],
};
const citations = [
  {
    type: 'url_citation',
    url_citation: {
      url: officialUrl,
      title: 'Lone Star Cash Home Buyers | Texas',
      content: 'Lone Star Cash Home Buyers purchases homes for cash throughout Texas.',
    },
  },
  {
    type: 'url_citation',
    url_citation: {
      url: evidenceUrl,
      title: 'Lone Star Cash Home Buyers in Texas',
      content: 'Lone Star Cash Home Buyers is a Texas cash home buyer that purchases houses directly. Jordan Marks is the Founder. Contact Jordan Marks at jordan@lonestarbuyers.example.',
    },
  },
];

function completion(companies: unknown[] = [company], annotations: unknown[] = citations) {
  return {
    choices: [{
      message: {
        content: JSON.stringify({ companies }),
        annotations,
      },
    }],
  };
}

function batchCompletion(start: number, count: number) {
  const companies = [];
  const annotations = [];
  for (let index = start; index < start + count; index += 1) {
    const name = `Texas Cash Home Buyers ${index}`;
    const website = `https://texasbuyers${index}.example/`;
    const evidence = `https://texasbuyers${index}.example/about`;
    companies.push({
      company_name: name,
      official_website: website,
      evidence_url: evidence,
      contacts: [],
    });
    annotations.push(
      {
        type: 'url_citation',
        url_citation: {
          url: website,
          title: `${name} | Official`,
          content: `${name} purchases homes for cash throughout Texas.`,
        },
      },
      {
        type: 'url_citation',
        url_citation: {
          url: evidence,
          title: `${name} in Texas`,
          content: `${name} is a Texas cash home buyer that purchases houses directly.`,
        },
      },
    );
  }
  return completion(companies, annotations);
}

function httpResponse(status: number, body: unknown) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function setup(payload: unknown, status = 200, overrides: Record<string, unknown> = {}) {
  const fetchMock = jest.fn().mockResolvedValue(httpResponse(status, payload));
  const outbound = {
    fetch: fetchMock,
  } as unknown as OutboundRequestService;
  const values: Record<string, unknown> = {
    'openRouter.apiKey': 'openrouter-test-secret',
    'openRouter.model': 'openai/gpt-4o-mini',
    'openRouter.baseUrl': 'https://openrouter.ai/api/v1',
    'openRouter.timeoutMs': 5000,
    'sourceProvider.discoveryQueryConcurrency': 1,
    'sourceProvider.discoveryQueryTimeoutMs': 5000,
    'sourceProvider.retryDelayMs': 0,
    'sourceProvider.discoveryMaxConsecutiveFailures': 1,
    'webSearch.maxResults': 5,
    ...overrides,
  };
  const config = { get: (key: string) => values[key] } as ConfigService;
  return { provider: new OpenRouterDiscoveryProvider(outbound, config), fetchMock };
}

describe('OpenRouterDiscoveryProvider', () => {
  it('uses Chat Completions with the web plugin and returns citation-backed normalized Texas companies', async () => {
    const { provider, fetchMock } = setup(completion());

    const result = await provider.searchBusinesses(plan, context);

    expect(result).toMatchObject({
      provider: 'openrouter',
      results: [{
        name: 'Lone Star Cash Home Buyers',
        website: 'https://lonestarbuyers.example',
        sourceUrl: evidenceUrl,
        address: { state: 'Texas', country: 'US' },
        rawData: {
          openRouterContacts: [{
            fullName: 'Jordan Marks',
            title: 'Founder',
            email: 'jordan@lonestarbuyers.example',
            sourceUrl: evidenceUrl,
          }],
        },
      }],
      queriesRun: 1,
    });
    const fetchCall = fetchMock.mock.calls[0];
    expect(fetchCall?.[0]).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(fetchCall?.[1]?.method).toBe('POST');
    expect(fetchCall?.[1]?.headers).toMatchObject({ Authorization: 'Bearer openrouter-test-secret' });
    expect(fetchCall?.[1]?.body).toContain('"plugins":[{"id":"web","max_results":5}]');
    expect(fetchCall?.[2]).toBe(5000);
    expect(fetchCall?.[3]).toBe(0);
    const request = JSON.parse(String(fetchCall?.[1]?.body)) as {
      messages: Array<{ content: string }>;
    };
    expect(request.messages[1]?.content).toContain('Texas');
    expect(request.messages[1]?.content).toContain('cash_home_buyer, fix_and_flip, wholesaler');
    expect(JSON.stringify(result)).toContain('jordan@lonestarbuyers.example');
  });

  it('uses the OpenRouter auto model when no model is configured for discovery', async () => {
    const { provider, fetchMock } = setup(completion(), 200, { 'openRouter.model': '' });

    await provider.searchBusinesses(plan, context);

    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { model: string };
    expect(request.model).toBe('openrouter/auto');
  });

  it('retries one transient 5xx response and uses the default 120-second request timeout', async () => {
    const { provider, fetchMock } = setup(completion(), 200, { 'openRouter.timeoutMs': undefined });
    fetchMock.mockReset()
      .mockResolvedValueOnce(httpResponse(503, { error: 'temporary' }))
      .mockResolvedValueOnce(httpResponse(200, completion()));

    const result = await provider.searchBusinesses(plan, context);

    expect(result.results).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[2]).toBe(120000);
    expect(fetchMock.mock.calls[0]?.[3]).toBe(0);
  });

  it('retries one network failure and then succeeds', async () => {
    const { provider, fetchMock } = setup(completion());
    fetchMock.mockReset()
      .mockRejectedValueOnce(new Error('socket connection failed'))
      .mockResolvedValueOnce(httpResponse(200, completion()));

    await expect(provider.searchBusinesses(plan, context)).resolves.toMatchObject({ results: expect.any(Array) });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('splits large targets into batches of at most 20 and aggregates their results', async () => {
    const { provider, fetchMock } = setup(batchCompletion(0, 20), 200, {
      'openRouter.timeoutMs': 120000,
      'sourceProvider.discoveryQueryTimeoutMs': 120000,
    });
    fetchMock.mockReset()
      .mockResolvedValueOnce(httpResponse(200, batchCompletion(0, 20)))
      .mockResolvedValueOnce(httpResponse(200, batchCompletion(20, 20)));

    const result = await provider.searchBusinesses({
      ...plan,
      requestedCount: 40,
      maxResults: 40,
    }, context);

    expect(result.results).toHaveLength(40);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstRequest = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      messages: Array<{ content: string }>;
    };
    const secondRequest = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as {
      messages: Array<{ content: string }>;
    };
    expect(firstRequest.messages[1]?.content).toContain('up to 20 distinct matching companies');
    expect(secondRequest.messages[1]?.content).toContain('up to 20 distinct matching companies');
    expect(fetchMock.mock.calls[0]?.[2]).toBe(120000);
  });

  it('keeps successful batches when a later batch times out', async () => {
    const { provider, fetchMock } = setup(batchCompletion(0, 20), 200, {
      'openRouter.timeoutMs': 120000,
      'sourceProvider.discoveryQueryTimeoutMs': 120000,
      'sourceProvider.discoveryMaxConsecutiveFailures': 1,
    });
    fetchMock.mockReset()
      .mockResolvedValueOnce(httpResponse(200, batchCompletion(0, 20)))
      .mockRejectedValueOnce(new OutboundRequestError('Outbound request timed out'))
      .mockRejectedValueOnce(new OutboundRequestError('Outbound request timed out'))
      .mockResolvedValueOnce(httpResponse(200, batchCompletion(20, 20)));

    const result = await provider.searchBusinesses({
      ...plan,
      requestedCount: 40,
      maxResults: 40,
    }, context);

    expect(result.results).toHaveLength(40);
    expect(result.providerError).toMatch(/timed out/i);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('continues to later batches when a sub-query returns malformed company data', async () => {
    const { provider, fetchMock } = setup(batchCompletion(0, 20), 200, {
      'openRouter.timeoutMs': 120000,
      'sourceProvider.discoveryQueryTimeoutMs': 120000,
      'sourceProvider.discoveryMaxConsecutiveFailures': 1,
    });
    fetchMock.mockReset()
      .mockResolvedValueOnce(httpResponse(200, batchCompletion(0, 20)))
      .mockResolvedValueOnce(httpResponse(200, {
        choices: [{ message: { content: '{"companies":"invalid"}', annotations: [] } }],
      }))
      .mockResolvedValueOnce(httpResponse(200, batchCompletion(20, 20)));

    const result = await provider.searchBusinesses({
      ...plan,
      requestedCount: 40,
      maxResults: 40,
    }, context);

    expect(result.results).toHaveLength(40);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('treats a valid empty company list as a successful empty search', async () => {
    const { provider } = setup({ choices: [{ message: { content: '{"companies":[]}' } }] });

    const result = await provider.searchBusinesses(plan, context);

    expect(result).toMatchObject({ provider: 'openrouter', results: [] });
    expect(result.providerError).toBeUndefined();
  });

  it('distinguishes quota exhaustion from rate limiting', async () => {
    const quota = setup({ error: { message: 'insufficient credits' } }, 402).provider;
    const rateLimited = setup({ error: { message: 'rate limit' } }, 429).provider;

    await expect(quota.searchBusinesses(plan, context)).rejects.toMatchObject({ code: 'PROVIDER_QUOTA_EXCEEDED' });
    await expect(rateLimited.searchBusinesses(plan, context)).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMITED' });
  });

  it('reports authentication failures without treating them as quota errors', async () => {
    const { provider } = setup({ error: { message: 'invalid api key' } }, 401);

    await expect(provider.searchBusinesses(plan, context)).rejects.toMatchObject({ code: 'PROVIDER_AUTH_ERROR' });
  });

  it('rejects malformed provider responses explicitly', async () => {
    const { provider } = setup({ choices: [{ message: { content: '{"companies":"not-an-array"}', annotations: citations } }] });

    await expect(provider.searchBusinesses(plan, context)).rejects.toBeInstanceOf(SourceProviderError);
    await expect(provider.searchBusinesses(plan, context)).rejects.toMatchObject({ code: 'PROVIDER_INVALID_RESPONSE' });
  });

  it('deduplicates repeated companies and filters out other states and unrelated categories', async () => {
    const floridaCompany = { company_name: 'Florida Cash Home Buyers', official_website: 'https://floridabuyers.example/', evidence_url: 'https://floridabuyers.example/about' };
    const realtor = { company_name: 'Texas Realty Group', official_website: 'https://texasrealty.example/', evidence_url: 'https://texasrealty.example/about' };
    const annotated = [
      ...citations,
      ...[
        ['https://floridabuyers.example/', 'Florida Cash Home Buyers', 'Florida Cash Home Buyers purchases homes for cash in Florida.'],
        ['https://floridabuyers.example/about', 'Florida Cash Home Buyers in Florida', 'Florida Cash Home Buyers is based in Florida.'],
        ['https://texasrealty.example/', 'Texas Realty Group', 'Texas Realty Group is a real estate agency serving Texas home sellers.'],
        ['https://texasrealty.example/about', 'Texas Realty Group in Texas', 'Texas Realty Group provides realtor representation in Texas.'],
      ].map(([url, title, content]) => ({ type: 'url_citation', url_citation: { url, title, content } })),
    ];
    const { provider } = setup(completion([floridaCompany, realtor, company, company], annotated));

    const result = await provider.searchBusinesses({ ...plan, requestedCount: 2, maxResults: 2 }, context);

    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.name).toBe(company.company_name);
    expect(result.rejectedCandidates).toBeGreaterThan(0);
    expect(result.duplicatesRemoved).toBeGreaterThan(0);
  });

  it('reports configuration failure when the API key is not configured', async () => {
    const { provider, fetchMock } = setup(completion(), 200, { 'openRouter.apiKey': '' });

    expect(provider.health()).toEqual({ name: 'openrouter', configured: false, enabled: false });
    await expect(provider.searchBusinesses(plan, context)).rejects.toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports network failures as provider unavailable', async () => {
    const { provider, fetchMock } = setup(completion());
    fetchMock.mockRejectedValue(new Error('socket connection failed'));

    await expect(provider.searchBusinesses(plan, context)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
