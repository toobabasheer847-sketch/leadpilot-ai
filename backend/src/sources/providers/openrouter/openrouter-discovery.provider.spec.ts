import { Logger } from '@nestjs/common';
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
    'openRouter.retries': 1,
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
          openRouterFields: {
            companyName: 'Lone Star Cash Home Buyers',
            website: 'https://lonestarbuyers.example',
            personName: 'Jordan Marks',
            personTitle: 'Founder',
            personEmail: 'jordan@lonestarbuyers.example',
          },
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
    expect(fetchCall?.[2]).toBeLessThanOrEqual(5000);
    expect(fetchCall?.[2]).toBeGreaterThan(0);
    expect(fetchCall?.[3]).toBe(0);
    const request = JSON.parse(String(fetchCall?.[1]?.body)) as {
      max_tokens: number;
      messages: Array<{ content: string }>;
    };
    expect(request.max_tokens).toBe(4000);
    expect(request.messages[0]?.content).toContain('readable Markdown');
    expect(request.messages[0]?.content).toContain('not JSON');
    expect(request.messages[0]?.content).toContain('Founder / Owner / CEO full name');
    expect(request.messages[0]?.content).toContain('publicly available email or contact email');
    expect(request.messages[1]?.content).toContain('Texas');
    expect(request.messages[1]?.content).toContain('cash_home_buyer, fix_and_flip, wholesaler');
    expect(JSON.stringify(result)).toContain('jordan@lonestarbuyers.example');
  });

  it('retries HTTP 429 up to three times and recovers when the rate limit clears', async () => {
    const { provider, fetchMock } = setup(completion());
    const sleep = jest.spyOn(provider as unknown as { sleep: (milliseconds: number) => Promise<void> }, 'sleep')
      .mockResolvedValue(undefined);
    fetchMock.mockReset()
      .mockResolvedValueOnce(httpResponse(429, { error: 'rate limited' }))
      .mockResolvedValueOnce(httpResponse(429, { error: 'rate limited' }))
      .mockResolvedValueOnce(httpResponse(200, completion()));

    try {
      await expect(provider.searchBusinesses(plan, context)).resolves.toMatchObject({
        results: [expect.objectContaining({ name: company.company_name })],
      });
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(sleep.mock.calls).toEqual([[2000], [4000]]);
    } finally {
      sleep.mockRestore();
    }
  });

  it('continues to another sub-query after exhausting transient retries on a batch', async () => {
    const { provider, fetchMock } = setup(completion());
    const sleep = jest.spyOn(provider as unknown as { sleep: (milliseconds: number) => Promise<void> }, 'sleep')
      .mockResolvedValue(undefined);
    fetchMock.mockReset()
      .mockResolvedValueOnce(httpResponse(503, { error: 'temporary' }))
      .mockResolvedValueOnce(httpResponse(503, { error: 'temporary' }))
      .mockResolvedValueOnce(httpResponse(503, { error: 'temporary' }))
      .mockResolvedValueOnce(httpResponse(503, { error: 'temporary' }))
      .mockResolvedValueOnce(httpResponse(200, completion()));

    try {
      const result = await provider.searchBusinesses(plan, context);

      expect(result.results).toHaveLength(1);
      expect(result.providerError).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(6);
      expect(sleep.mock.calls).toEqual([[2000], [4000], [3000], [2000]]);
    } finally {
      sleep.mockRestore();
    }
  });

  it('uses the OpenRouter auto model when no model is configured for discovery', async () => {
    const { provider, fetchMock } = setup(completion(), 200, { 'openRouter.model': '' });

    await provider.searchBusinesses(plan, context);

    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { model: string };
    expect(request.model).toBe('openrouter/auto');
  });

  it('parses JSON enclosed in a markdown code block', async () => {
    const payload = completion();
    payload.choices[0]!.message.content = `\`\`\`json\n${JSON.stringify({ companies: [company] })}\n\`\`\``;
    const { provider } = setup(payload);

    await expect(provider.searchBusinesses(plan, context)).resolves.toMatchObject({
      results: [expect.objectContaining({ name: company.company_name })],
    });
  });

  it('extracts an embedded JSON candidate object from surrounding text', async () => {
    const payload = completion();
    payload.choices[0]!.message.content = `Companies found:\n${JSON.stringify({ companies: [company] })}\nSearch complete.`;
    const { provider } = setup(payload);

    await expect(provider.searchBusinesses(plan, context)).resolves.toMatchObject({
      results: [expect.objectContaining({ name: company.company_name })],
    });
  });

  it('repairs truncated JSON and retains fully formed company records', async () => {
    const payload = completion();
    payload.choices[0]!.message.content = `{"companies":[${JSON.stringify(company)},{"company_name":"Incomplete`;
    const { provider } = setup(payload);

    const result = await provider.searchBusinesses(plan, context);

    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      name: company.company_name,
      website: 'https://lonestarbuyers.example',
      sourceUrl: evidenceUrl,
    });
  });

  it('accepts JSON candidates without citation annotations and uses the official website as fallback provenance', async () => {
    const uncitedCompany = {
      company_name: 'Lone Star Cash Home Buyers',
      official_website: officialUrl,
      activity: 'A Texas cash home buyer purchasing houses directly.',
      location: 'Texas',
      contacts: [{
        full_name: 'Jordan Marks',
        title: 'Founder',
        email: 'jordan@lonestarbuyers.example',
      }],
    };
    const { provider } = setup(completion([uncitedCompany], []));

    const result = await provider.searchBusinesses(plan, context);

    expect(result).toMatchObject({
      results: [{
        name: company.company_name,
        website: 'https://lonestarbuyers.example',
        sourceUrl: officialUrl,
        rawData: {
          citationStatus: 'CITATION_ANNOTATION_MISSING',
          snippet: expect.stringContaining('cash home buyer'),
          openRouterContacts: [{
            fullName: 'Jordan Marks',
            title: 'Founder',
            email: 'jordan@lonestarbuyers.example',
            sourceUrl: officialUrl,
          }],
        },
      }],
    });
  });

  it('uses a matching citation URL when a JSON company has no explicit website', async () => {
    const withoutWebsite = {
      company_name: 'Lone Star Cash Home Buyers',
      activity: 'A Texas cash home buyer purchasing houses directly.',
    };
    const { provider } = setup(completion([withoutWebsite], citations));

    const result = await provider.searchBusinesses(plan, context);

    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      name: 'Lone Star Cash Home Buyers',
      website: 'https://lonestarbuyers.example',
      sourceUrl: evidenceUrl,
    });
  });

  it('extracts public company and decision-maker social URLs and generic emails', async () => {
    const enrichedCompany = {
      ...company,
      email: 'info@lonestarbuyers.example',
      company_facebook: 'https://facebook.com/lonestarbuyers',
      company_instagram: 'https://instagram.com/lonestarbuyers',
      contacts: [{
        ...company.contacts[0],
        email: 'contact@lonestarbuyers.example',
        linkedin_url: 'https://linkedin.com/in/jordan-marks',
      }],
    };
    const annotations = [
      ...citations,
      {
        type: 'url_citation',
        url_citation: {
          url: 'https://facebook.com/lonestarbuyers',
          title: 'Lone Star Cash Home Buyers Facebook',
          content: 'Lone Star Cash Home Buyers official Facebook page. Email contact@lonestarbuyers.example. Jordan Marks, Founder, https://linkedin.com/in/jordan-marks.',
        },
      },
      {
        type: 'url_citation',
        url_citation: {
          url: 'https://instagram.com/lonestarbuyers',
          title: 'Lone Star Cash Home Buyers Instagram',
          content: 'Lone Star Cash Home Buyers official Instagram page.',
        },
      },
    ];
    const { provider, fetchMock } = setup(completion([enrichedCompany], annotations));

    const result = await provider.searchBusinesses(plan, context);

    expect(result.results[0]).toMatchObject({
      email: 'info@lonestarbuyers.example',
      rawData: {
        openRouterSocialProfiles: expect.arrayContaining([
          { platform: 'facebook', profileUrl: 'https://facebook.com/lonestarbuyers', role: 'company' },
          { platform: 'instagram', profileUrl: 'https://instagram.com/lonestarbuyers', role: 'company' },
          { platform: 'linkedin', profileUrl: 'https://linkedin.com/in/jordan-marks', role: 'decision_maker' },
        ]),
        openRouterContacts: [expect.objectContaining({
          email: 'contact@lonestarbuyers.example',
          linkedinUrl: 'https://linkedin.com/in/jordan-marks',
        })],
      },
    });
    const targetedQuery = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as {
      messages: Array<{ content: string }>;
    };
    expect(targetedQuery.messages[1]?.content).toContain(
      'Find LinkedIn, Facebook, Instagram profile, and contact email for Lone Star Cash Home Buyers',
    );
  });

  it('force-accepts OpenRouter candidates pending qualification without counting them as rejected', async () => {
    const unrelatedForPlan = {
      company_name: 'Colorado Roofing Company',
      official_website: 'https://coloradoroofing.example/',
      activity: 'A roofing company located in Denver, Colorado.',
    };
    const annotations = [{
      type: 'url_citation',
      url_citation: {
        url: unrelatedForPlan.official_website,
        title: 'Colorado Roofing Company Official Website',
        content: unrelatedForPlan.activity,
      },
    }];
    const { provider } = setup(completion([unrelatedForPlan], annotations));

    const result = await provider.searchBusinesses(plan, context);

    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      name: 'Colorado Roofing Company',
      website: 'https://coloradoroofing.example',
      rawData: { qualificationStatus: 'PENDING' },
    });
    expect(result.results[0]?.address).toEqual({});
    expect(result.rejectedCandidates).toBe(0);
  });

  it('parses a plain-text company bullet list with cited website and evidence URLs', async () => {
    const payload = completion();
    payload.choices[0]!.message.content = [
      '- Company Name: Lone Star Cash Home Buyers',
      `  Official Website: ${officialUrl}`,
      `  Evidence URL: ${evidenceUrl}`,
      '  Person Name: Jordan Marks',
      '  Title: Founder',
      '  Email: jordan@lonestarbuyers.example',
    ].join('\n');
    const { provider } = setup(payload);

    const result = await provider.searchBusinesses(plan, context);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      name: company.company_name,
      website: 'https://lonestarbuyers.example',
      sourceUrl: evidenceUrl,
    });
    expect(result.results[0]?.rawData?.openRouterContacts).toEqual([
      expect.objectContaining({
        fullName: 'Jordan Marks',
        title: 'Founder',
        email: 'jordan@lonestarbuyers.example',
      }),
    ]);
  });

  it('extracts companies, cited websites, decision makers, and email from Markdown and citation text', async () => {
    const payload = completion();
    payload.choices[0]!.message.content = [
      '**Lone Star Cash Home Buyers** is a Texas cash home buyer purchasing houses directly.',
      'Owner Jordan Marks is the Founder. Contact Jordan Marks at jordan@lonestarbuyers.example.',
      `[Lone Star Cash Home Buyers official website](${officialUrl})`,
    ].join('\n\n');
    const { provider } = setup(payload);

    const result = await provider.searchBusinesses(plan, context);

    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      name: 'Lone Star Cash Home Buyers',
      website: 'https://lonestarbuyers.example',
      sourceUrl: evidenceUrl,
      rawData: {
        openRouterFields: {
          personName: 'Jordan Marks',
          personTitle: 'Founder',
          personEmail: 'jordan@lonestarbuyers.example',
        },
      },
    });
  });

  it('logs a bounded raw response in debug output', async () => {
    const debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
    try {
      const { provider } = setup(completion());
      await provider.searchBusinesses(plan, context);

      expect(debug).toHaveBeenCalledWith(expect.stringContaining('"event":"discovery.search.raw_response"'));
      expect(String(debug.mock.calls[0]?.[0]).length).toBeLessThanOrEqual(4300);
    } finally {
      debug.mockRestore();
    }
  });

  it('logs OpenRouter candidate acceptance in debug mode', async () => {
    const debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
    try {
      const candidate = {
        company_name: 'Colorado Roofing Company',
        official_website: 'https://coloradoroofing.example/',
        activity: 'A roofing company located in Denver, Colorado.',
      };
      const annotations = [{
        type: 'url_citation',
        url_citation: {
          url: candidate.official_website,
          title: 'Colorado Roofing Company Official Website',
          content: candidate.activity,
        },
      }];
      const { provider } = setup(completion([candidate], annotations));

      await provider.searchBusinesses(plan, context);

      expect(debug).toHaveBeenCalledWith(
        '[OpenRouterAssessment] Candidate accepted with PENDING status: Colorado Roofing Company',
      );
    } finally {
      debug.mockRestore();
    }
  });

  it('retries transient 5xx responses with exponential backoff', async () => {
    const { provider, fetchMock } = setup(completion(), 200, { 'openRouter.timeoutMs': 30000 });
    const sleep = jest.spyOn(provider as unknown as { sleep: (milliseconds: number) => Promise<void> }, 'sleep')
      .mockResolvedValue(undefined);
    fetchMock.mockReset()
      .mockResolvedValueOnce(httpResponse(503, { error: 'temporary' }))
      .mockResolvedValueOnce(httpResponse(503, { error: 'temporary' }))
      .mockResolvedValueOnce(httpResponse(503, { error: 'temporary' }))
      .mockResolvedValueOnce(httpResponse(200, completion()));

    try {
      const result = await provider.searchBusinesses(plan, context);

      expect(result.results).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalledTimes(5);
      expect(sleep.mock.calls).toEqual([[2000], [4000], [8000]]);
      expect(fetchMock.mock.calls[0]?.[2]).toBeLessThanOrEqual(30000);
      expect(fetchMock.mock.calls[0]?.[2]).toBeGreaterThan(0);
      expect(fetchMock.mock.calls[0]?.[3]).toBe(0);
    } finally {
      sleep.mockRestore();
    }
  });

  it('retries one network failure and then succeeds', async () => {
    const { provider, fetchMock } = setup(completion());
    const sleep = jest.spyOn(provider as unknown as { sleep: (milliseconds: number) => Promise<void> }, 'sleep')
      .mockResolvedValue(undefined);
    fetchMock.mockReset()
      .mockRejectedValueOnce(new Error('socket connection failed'))
      .mockResolvedValueOnce(httpResponse(200, completion()));

    try {
      await expect(provider.searchBusinesses(plan, context)).resolves.toMatchObject({ results: expect.any(Array) });
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(sleep).toHaveBeenCalledWith(2000);
    } finally {
      sleep.mockRestore();
    }
  });

  it('continues to the next sub-query after a timed-out request', async () => {
    const { provider, fetchMock } = setup(completion(), 200, {
      'openRouter.timeoutMs': 120000,
      'openRouter.retries': 2,
      'sourceProvider.discoveryQueryTimeoutMs': 120000,
    });
    const sleep = jest.spyOn(provider as unknown as { sleep: (milliseconds: number) => Promise<void> }, 'sleep')
      .mockResolvedValue(undefined);
    fetchMock.mockReset()
      .mockRejectedValueOnce(new OutboundRequestError('Outbound request timed out'))
      .mockResolvedValueOnce(httpResponse(200, completion()));

    try {
      const result = await provider.searchBusinesses(plan, context);

      expect(result.results).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(fetchMock.mock.calls[0]?.[2]).toBeLessThanOrEqual(30000);
      expect(sleep.mock.calls).toEqual([[3000]]);
    } finally {
      sleep.mockRestore();
    }
  });

  it('uses two configured retries for transient network failures', async () => {
    const { provider, fetchMock } = setup(completion(), 200, {
      'openRouter.retries': 2,
      'openRouter.timeoutMs': 30000,
    });
    const sleep = jest.spyOn(provider as unknown as { sleep: (milliseconds: number) => Promise<void> }, 'sleep')
      .mockResolvedValue(undefined);
    fetchMock.mockReset()
      .mockRejectedValueOnce(new Error('socket connection failed'))
      .mockRejectedValueOnce(new Error('socket connection failed'))
      .mockResolvedValueOnce(httpResponse(200, completion()));

    try {
      await expect(provider.searchBusinesses(plan, context)).resolves.toMatchObject({ results: expect.any(Array) });
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(sleep.mock.calls).toEqual([[2000], [4000]]);
    } finally {
      sleep.mockRestore();
    }
  });

  it('splits large targets into batches of at most 10 and aggregates their results', async () => {
    const { provider, fetchMock } = setup(batchCompletion(0, 20), 200, {
      'openRouter.timeoutMs': 120000,
      'sourceProvider.discoveryQueryTimeoutMs': 120000,
    });
    fetchMock.mockReset()
      .mockResolvedValueOnce(httpResponse(200, batchCompletion(0, 10)))
      .mockResolvedValueOnce(httpResponse(200, batchCompletion(10, 10)))
      .mockResolvedValueOnce(httpResponse(200, batchCompletion(20, 10)))
      .mockResolvedValueOnce(httpResponse(200, batchCompletion(30, 10)));

    const result = await provider.searchBusinesses({
      ...plan,
      requestedCount: 40,
      maxResults: 40,
    }, context);

    expect(result.results).toHaveLength(40);
    expect(fetchMock).toHaveBeenCalledTimes(44);
    const firstRequest = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      messages: Array<{ content: string }>;
    };
    const secondRequest = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as {
      messages: Array<{ content: string }>;
    };
    expect(firstRequest.messages[1]?.content).toContain('up to 10 distinct matching companies');
    expect(secondRequest.messages[1]?.content).toContain('up to 10 distinct matching companies');
    expect(fetchMock.mock.calls[0]?.[2]).toBeLessThanOrEqual(30000);
  });

  it('uses 15-company Texas city sub-queries to meet large lead targets', async () => {
    const { provider, fetchMock } = setup(batchCompletion(0, 15), 200, {
      'openRouter.timeoutMs': 120000,
      'sourceProvider.discoveryQueryTimeoutMs': 120000,
    });
    const sleep = jest.spyOn(provider as unknown as { sleep: (milliseconds: number) => Promise<void> }, 'sleep')
      .mockResolvedValue(undefined);
    fetchMock.mockReset();
    for (let chunk = 0; chunk < 7; chunk += 1) {
      fetchMock.mockResolvedValueOnce(httpResponse(200, batchCompletion(chunk * 15, 15)));
    }

    try {
      const result = await provider.searchBusinesses({
        ...plan,
        requestedCount: 100,
        maxResults: 100,
      }, context);

      expect(result.results).toHaveLength(100);
      expect(fetchMock).toHaveBeenCalledTimes(107);
      expect(fetchMock.mock.calls.every((call) =>
        String(call[1]?.body).includes('"plugins":[{"id":"web","max_results":10}]'),
      )).toBe(true);
      const expectedCities = [
        'Dallas', 'Houston', 'Austin', 'San Antonio', 'Fort Worth', 'El Paso', 'Arlington',
      ];
      for (const [index, city] of expectedCities.entries()) {
        const request = JSON.parse(String(fetchMock.mock.calls[index]?.[1]?.body)) as {
          messages: Array<{ content: string }>;
        };
        expect(request.messages[1]?.content).toContain(`in ${city} TX`);
        expect(request.messages[1]?.content).toMatch(/contact email|LinkedIn Facebook|founder email|contact details/);
        expect(request.messages[1]?.content).not.toMatch(/Texas real estate investor companies/i);
        if (index < expectedCities.length - 1) {
          expect(request.messages[1]?.content).toContain('up to 15 distinct matching companies');
        }
      }
      expect(sleep).toHaveBeenCalledWith(1000);
    } finally {
      sleep.mockRestore();
    }
  });

  it('keeps companies without public contact details as pending discovery candidates', async () => {
    const companyWithoutContacts = {
      company_name: 'Lone Star Cash Home Buyers',
      official_website: officialUrl,
    };
    const { provider } = setup(completion([companyWithoutContacts], []));

    const result = await provider.searchBusinesses(plan, context);

    expect(result.results).toHaveLength(1);
    expect(result.rejectedCandidates).toBe(0);
    expect(result.results[0]?.rawData).toMatchObject({
      qualificationStatus: 'PENDING',
      openRouterFields: {
        personName: null,
        personTitle: null,
        personEmail: null,
      },
    });
  });

  it('keeps successful batches when a later batch times out', async () => {
    const { provider, fetchMock } = setup(batchCompletion(0, 20), 200, {
      'openRouter.timeoutMs': 120000,
      'sourceProvider.discoveryQueryTimeoutMs': 120000,
      'sourceProvider.discoveryMaxConsecutiveFailures': 1,
    });
    const sleep = jest.spyOn(provider as unknown as { sleep: (milliseconds: number) => Promise<void> }, 'sleep')
      .mockResolvedValue(undefined);
    fetchMock.mockReset()
      .mockResolvedValueOnce(httpResponse(200, batchCompletion(0, 10)))
      .mockRejectedValueOnce(new OutboundRequestError('Outbound request timed out'))
      .mockResolvedValueOnce(httpResponse(200, batchCompletion(10, 10)))
      .mockResolvedValueOnce(httpResponse(200, batchCompletion(20, 10)));

    try {
      const result = await provider.searchBusinesses({
        ...plan,
        requestedCount: 30,
        maxResults: 30,
      }, context);

      expect(result.results).toHaveLength(30);
      expect(result.providerError).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(34);
      expect(sleep).toHaveBeenCalledWith(3000);
    } finally {
      sleep.mockRestore();
    }
  });

  it('continues to later batches when a sub-query returns malformed company data', async () => {
    const { provider, fetchMock } = setup(batchCompletion(0, 20), 200, {
      'openRouter.timeoutMs': 120000,
      'sourceProvider.discoveryQueryTimeoutMs': 120000,
      'sourceProvider.discoveryMaxConsecutiveFailures': 1,
    });
    fetchMock.mockReset()
      .mockResolvedValueOnce(httpResponse(200, batchCompletion(0, 10)))
      .mockResolvedValueOnce(httpResponse(200, {
        choices: [{ message: { content: '{"companies":"invalid"}', annotations: [] } }],
      }))
      .mockResolvedValueOnce(httpResponse(200, batchCompletion(10, 10)))
      .mockResolvedValueOnce(httpResponse(200, batchCompletion(20, 10)));

    const result = await provider.searchBusinesses({
      ...plan,
      requestedCount: 30,
      maxResults: 30,
    }, context);

    expect(result.results).toHaveLength(30);
    expect(fetchMock).toHaveBeenCalledTimes(34);
  });

  it('treats a valid empty company list as a successful empty search', async () => {
    const { provider } = setup({ choices: [{ message: { content: '{"companies":[]}' } }] });

    const result = await provider.searchBusinesses(plan, context);

    expect(result).toMatchObject({ provider: 'openrouter', results: [] });
    expect(result.providerError).toBeUndefined();
  });

  it('distinguishes quota exhaustion from rate limiting', async () => {
    const quota = setup({ error: { message: 'insufficient credits' } }, 402).provider;
    const rateLimited = setup({ error: { message: 'rate limit' } }, 429, {
      'openRouter.timeoutMs': 30000,
    }).provider;
    const sleep = jest.spyOn(rateLimited as unknown as { sleep: (milliseconds: number) => Promise<void> }, 'sleep')
      .mockResolvedValue(undefined);

    try {
      await expect(quota.searchBusinesses(plan, context)).rejects.toMatchObject({ code: 'PROVIDER_QUOTA_EXCEEDED' });
      const result = await rateLimited.searchBusinesses(plan, context);
      expect(result).toMatchObject({
        results: [],
        providerError: expect.stringMatching(/rate limit/i),
      });
      expect(sleep.mock.calls.filter(([delay]) => delay < 10000)).toHaveLength(7);
      expect(sleep.mock.calls.filter(([delay]) => delay === 2000)).toHaveLength(2);
      expect(sleep.mock.calls.filter(([delay]) => delay === 4000)).toHaveLength(2);
      expect(sleep.mock.calls.filter(([delay]) => delay === 8000)).toHaveLength(2);
      expect(sleep.mock.calls.filter(([delay]) => delay === 3000)).toHaveLength(1);
    } finally {
      sleep.mockRestore();
    }
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

  it.each([
    ['a string response body', 'unexpected response'],
    ['a missing choices array', { choices: null }],
    ['a missing message', { choices: [{}] }],
    ['a non-string message content', { choices: [{ message: { content: { companies: [] } } }] }],
  ])('maps %s to a provider response error instead of a runtime exception', async (_description, body) => {
    const { provider } = setup(body);

    await expect(provider.searchBusinesses(plan, context)).rejects.toBeInstanceOf(SourceProviderError);
    await expect(provider.searchBusinesses(plan, context)).rejects.toMatchObject({ code: 'PROVIDER_INVALID_RESPONSE' });
  });

  it('deduplicates OpenRouter raw candidates while deferring location and category qualification', async () => {
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

    const result = await provider.searchBusinesses({ ...plan, requestedCount: 4, maxResults: 4 }, context);

    expect(result.results).toHaveLength(3);
    expect(result.results.map((candidate) => candidate.name)).toEqual(expect.arrayContaining([
      company.company_name,
      'Florida Cash Home Buyers',
      'Texas Realty Group',
    ]));
    expect(result.results.every((candidate) => candidate.rawData?.qualificationStatus === 'PENDING')).toBe(true);
    expect(result.duplicatesRemoved).toBeGreaterThan(0);
  });

  it('retains same-website candidates with distinct decision makers', async () => {
    const ownerOne = { full_name: 'Jordan Marks', title: 'Founder', evidence_url: evidenceUrl };
    const ownerTwo = { full_name: 'Casey Lee', title: 'Managing Partner', evidence_url: evidenceUrl };
    const citation = [{
      type: 'url_citation',
      url_citation: {
        url: evidenceUrl,
        title: 'Lone Star Cash Home Buyers leadership',
        content: 'Lone Star Cash Home Buyers founder Jordan Marks and managing partner Casey Lee lead the company.',
      },
    }];
    const companyOne = { ...company, contacts: [ownerOne] };
    const companyTwo = { ...company, contacts: [ownerTwo] };
    const { provider } = setup(completion([companyOne, companyTwo], citation));

    const result = await provider.searchBusinesses({
      ...plan,
      requestedCount: 2,
      maxResults: 2,
    }, context);

    expect(result.results).toHaveLength(2);
    expect(result.results.map((candidate) =>
      (candidate.rawData?.openRouterContacts as Array<{ fullName: string }> | undefined)?.[0]?.fullName,
    )).toEqual(['Jordan Marks', 'Casey Lee']);
  });

  it('reports configuration failure when the API key is not configured', async () => {
    const { provider, fetchMock } = setup(completion(), 200, { 'openRouter.apiKey': '' });

    expect(provider.health()).toEqual({ name: 'openrouter', configured: false, enabled: false });
    await expect(provider.searchBusinesses(plan, context)).rejects.toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports network failures as provider unavailable', async () => {
    const { provider, fetchMock } = setup(completion(), 200, {
      'openRouter.retries': 0,
      'openRouter.timeoutMs': 30000,
    });
    const sleep = jest.spyOn(provider as unknown as { sleep: (milliseconds: number) => Promise<void> }, 'sleep')
      .mockResolvedValue(undefined);
    fetchMock.mockRejectedValue(new Error('socket connection failed'));

    try {
      const result = await provider.searchBusinesses(plan, context);
      expect(result).toMatchObject({ results: [], providerError: expect.stringMatching(/unavailable/i) });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledWith(3000);
    } finally {
      sleep.mockRestore();
    }
  });
});
