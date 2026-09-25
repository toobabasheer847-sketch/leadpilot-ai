import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { OutboundRequestError } from '../../common/outbound-request.service';
import { classifyPipelineError, summarizeJobStates } from '../../pipeline/pipeline.progress';
import { ConflictEngineService } from '../../verification/conflict/conflict-engine.service';
import type { VerificationEvidence } from '../../verification/types/verification.types';
import { CompanyEnrichmentRepository } from '../repositories/company-enrichment.repository';
import { EvidenceRepository } from '../repositories/evidence.repository';
import { EnrichmentService } from '../enrichment.service';
import { TavilyWebSearchProvider } from './tavily-web-search.provider';
import { buildWebSearchQuery, pageSupportsCompany } from './web-search.query';
import { WebSearchError } from './web-search.error';
import { WebSearchProvider } from './web-search.types';
import { WebsiteDiscoveryService } from './website-discovery.service';
import { WebsiteNormalizerService } from './website-normalizer.service';

function config(values: Record<string, unknown> = { 'website.fetchTimeoutMs': 1000 }) {
  return {
    get: (key: string, fallback?: unknown) => (Object.prototype.hasOwnProperty.call(values, key) ? values[key] : fallback),
  } as ConfigService;
}

function page(url: string, title: string, body: string) {
  return {
    url,
    finalUrl: url,
    statusCode: 200,
    contentType: 'text/html',
    body,
    title,
    description: title,
    canonicalUrl: url,
    redirectCount: 0,
  };
}

function discovery(fetchPage: jest.Mock, search?: WebSearchProvider) {
  return new WebsiteDiscoveryService(new WebsiteNormalizerService(), { fetchPage } as never, config(), search);
}

const TEST_API_KEY = 'tavily-test-secret';

function tavilyConfig(overrides: Record<string, unknown> = {}) {
  return config({
    'webSearch.provider': 'tavily',
    'webSearch.tavilyApiKey': TEST_API_KEY,
    'webSearch.tavilyApiUrl': 'https://api.tavily.com/search',
    'webSearch.timeoutMs': 1000,
    'webSearch.maxResults': 5,
    ...overrides,
  });
}

function httpResponse(status: number, body: unknown) {
  return {
    status,
    json: async () => {
      if (typeof body === 'string') throw new Error('invalid json');
      return body;
    },
  };
}

describe('web search website discovery', () => {
  const company = {
    companyName: 'Oak Stream Investors',
    state: 'Texas',
    country: 'US',
    category: 'financial',
  };

  it('preserves an existing official website and does not search', async () => {
    const fetchPage = jest.fn(async (url: string) => page(url, 'Oak Stream Investors', 'Oak Stream Investors in Texas'));
    const search = { name: 'tavily', search: jest.fn() };
    const result = await discovery(fetchPage, search).discover({ ...company, existingWebsite: 'https://oak.example/' });
    expect(result).toMatchObject({ status: 'FOUND', website: 'https://oak.example/', provider: 'stored_website' });
    expect(search.search).not.toHaveBeenCalled();
  });

  it('uses a valid OpenStreetMap website before web search', async () => {
    const fetchPage = jest.fn(async (url: string) => page(url, 'Oak Stream', 'Oak Stream'));
    const search = { name: 'tavily', search: jest.fn() };
    const result = await discovery(fetchPage, search).discover({ ...company, sourceWebsites: ['https://osm-site.example/'] });
    expect(result).toMatchObject({ status: 'FOUND', website: 'https://osm-site.example/', provider: 'source_metadata' });
    expect(search.search).not.toHaveBeenCalled();
  });

  it('searches when OpenStreetMap has no website and stores a supported official site', async () => {
    const fetchPage = jest.fn(async (url: string) => page(url, 'Oak Stream Investors', '<p>Oak Stream Investors serves Texas.</p>'));
    const search = {
      name: 'tavily',
      search: jest.fn().mockResolvedValue([{
        title: 'Oak Stream Investors',
        url: 'https://oak.example/',
        snippet: 'Oak Stream Investors in Texas',
        source: 'tavily',
        retrievedAt: '2026-09-25T16:00:00.000Z',
      }]),
    };
    const result = await discovery(fetchPage, search).discover(company);
    expect(search.search).toHaveBeenCalledWith(expect.objectContaining({ companyName: 'Oak Stream Investors', state: 'Texas', category: 'financial' }));
    expect(result).toMatchObject({
      status: 'FOUND',
      website: 'https://oak.example/',
      provider: 'tavily',
      sourceUrl: 'https://oak.example/',
      sourceType: 'WEBSITE',
      retrievedAt: '2026-09-25T16:00:00.000Z',
      searchHit: { source: 'tavily', snippet: 'Oak Stream Investors in Texas', url: 'https://oak.example/' },
    });
    expect(buildWebSearchQuery(company)).toBe('"Oak Stream Investors" Texas US financial');
    expect(buildWebSearchQuery(company)).not.toMatch(/\.com/i);
  });

  it('rejects an unrelated search result', async () => {
    const fetchPage = jest.fn(async (url: string) => page(url, 'Pizza Palace', '<p>Pizza in Austin.</p>'));
    const search = { name: 'tavily', search: jest.fn().mockResolvedValue([{ title: 'Pizza', url: 'https://pizza.example/', snippet: 'Pizza', source: 'tavily', retrievedAt: '2026-09-25T16:00:00.000Z' }]) };
    const result = await discovery(fetchPage, search).discover(company);
    expect(result.status).toBe('NOT_FOUND');
    expect(result.website).toBeNull();
  });

  it('evaluates multiple candidates and keeps the page that identifies the company', async () => {
    const fetchPage = jest.fn(async (url: string) => {
      if (String(url).includes('pizza')) return page(url, 'Pizza Palace', 'Pizza');
      if (String(url).includes('directory')) return page(url, 'Oak Stream Investors', 'Oak Stream Investors');
      return page(url, 'Oak Stream Investors', 'Oak Stream Investors of Texas');
    });
    const search = {
      name: 'tavily',
      search: jest.fn().mockResolvedValue([
        { title: 'Pizza', url: 'https://pizza.example/', snippet: 'Pizza', source: 'tavily', retrievedAt: '2026-09-25T16:00:00.000Z' },
        { title: 'Directory', url: 'https://directory.example/oak', snippet: 'Oak Stream Investors', source: 'tavily', retrievedAt: '2026-09-25T16:00:00.000Z' },
        { title: 'Official', url: 'https://oak.example/', snippet: 'Oak Stream Investors Texas', source: 'tavily', retrievedAt: '2026-09-25T16:00:00.000Z' },
      ]),
    };
    const result = await discovery(fetchPage, search).discover(company);
    expect(result.website).toBe('https://oak.example/');
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it('returns NOT_FOUND when search has no supported website and does not fabricate a domain', async () => {
    const fetchPage = jest.fn();
    const search = { name: 'tavily', search: jest.fn().mockResolvedValue([]) };
    const result = await discovery(fetchPage, search).discover({ companyName: 'Oak Stream Investors', state: 'Texas' });
    expect(result).toMatchObject({ status: 'NOT_FOUND', website: null });
    expect(fetchPage).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/oakstream/i);
    expect(pageSupportsCompany({ companyName: 'Oak Stream Investors', title: 'Welcome', text: 'Home', state: 'Texas' })).toBe(false);
    expect(classifyPipelineError(new Error(result.reason ?? '')).code).not.toBe('INTERNAL_ERROR');
  });

  it('reports a missing Tavily key as a configuration error and does not call the API', async () => {
    const fetch = jest.fn();
    const provider = new TavilyWebSearchProvider({ fetch } as never, tavilyConfig({ 'webSearch.tavilyApiKey': '' }));
    const fetchPage = jest.fn();
    await expect(discovery(fetchPage, provider).discover(company)).rejects.toMatchObject({
      name: 'WebSearchError',
      errorCode: 'CONFIGURATION_ERROR',
      retryable: false,
      message: 'Web search provider is not configured.',
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(fetchPage).not.toHaveBeenCalled();
    expect(classifyPipelineError(new Error('Web search provider is not configured.'))).toMatchObject({ code: 'CONFIGURATION_ERROR', message: 'Web search provider is not configured.' });
  });

  it('maps Tavily results and keeps the API key out of the request body and errors', async () => {
    const fetch = jest.fn().mockResolvedValue(httpResponse(200, {
      results: [
        { title: 'Oak Stream Investors', url: 'https://oak.example/', content: 'Oak Stream Investors in Texas', score: 0.91 },
        { title: 'Second', url: 'https://oak.example/about', content: 'About Oak Stream Investors', score: 0.4 },
        { title: 'Skipped', url: 'not-a-url', content: 'ignored', score: 0.1 },
      ],
    }));
    const provider = new TavilyWebSearchProvider({ fetch } as never, tavilyConfig());
    const results = await provider.search(company);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual(expect.objectContaining({
      title: 'Oak Stream Investors',
      url: 'https://oak.example/',
      snippet: 'Oak Stream Investors in Texas',
      source: 'tavily',
    }));
    expect(results[1].url).toBe('https://oak.example/about');
    expect(results[0].retrievedAt).toEqual(results[1].retrievedAt);
    const [endpoint, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(endpoint).toBe('https://api.tavily.com/search');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TEST_API_KEY}`);
    const rawBody = init.body;
    expect(typeof rawBody).toBe('string');
    const body = JSON.parse(rawBody as string);
    expect(body).toEqual({
      query: '"Oak Stream Investors" Texas US financial',
      max_results: 5,
      search_depth: 'basic',
      include_answer: false,
      include_raw_content: false,
    });
    expect(JSON.stringify(body)).not.toContain(TEST_API_KEY);
    expect(JSON.stringify(results)).not.toContain(TEST_API_KEY);
    const empty = jest.fn().mockResolvedValue(httpResponse(200, { results: [] }));
    await expect(new TavilyWebSearchProvider({ fetch: empty } as never, tavilyConfig()).search(company)).resolves.toEqual([]);
  });

  it('rejects directory and social results before fetching them as official websites', async () => {
    const fetchPage = jest.fn();
    const search = {
      name: 'tavily',
      search: jest.fn().mockResolvedValue([
        { title: 'LinkedIn', url: 'https://www.linkedin.com/company/oak', snippet: 'Oak Stream Investors', source: 'tavily', retrievedAt: '2026-09-25T16:00:00.000Z' },
        { title: 'Yelp', url: 'https://www.yelp.com/biz/oak-stream', snippet: 'Oak Stream Investors Texas', source: 'tavily', retrievedAt: '2026-09-25T16:00:00.000Z' },
      ]),
    };
    const result = await discovery(fetchPage, search).discover(company);
    expect(result).toMatchObject({ status: 'NOT_FOUND', website: null });
    expect(fetchPage).not.toHaveBeenCalled();
    expect(classifyPipelineError(new Error(result.reason ?? '')).code).not.toBe('INTERNAL_ERROR');
  });

  it('reports Tavily timeout, rate limit, http errors, and invalid responses without leaking the key', async () => {
    const query = { companyName: 'Oak Stream Investors', state: 'Texas' };
    const cases = [
      { fetch: jest.fn().mockRejectedValue(new OutboundRequestError('Outbound request timed out')), match: { errorCode: 'PROVIDER_TIMEOUT', retryable: true, message: 'Web search provider timed out.' } },
      { fetch: jest.fn().mockResolvedValue(httpResponse(429, {})), match: { errorCode: 'PROVIDER_RATE_LIMIT', retryable: true, message: 'Web search provider rate limit reached.' } },
      { fetch: jest.fn().mockResolvedValue(httpResponse(500, {})), match: { errorCode: 'PROVIDER_HTTP_ERROR', retryable: true, message: 'Web search provider returned HTTP 500.' } },
      { fetch: jest.fn().mockResolvedValue(httpResponse(400, { detail: { error: TEST_API_KEY } })), match: { errorCode: 'PROVIDER_HTTP_ERROR', retryable: false, message: 'Web search provider returned HTTP 400.' } },
      { fetch: jest.fn().mockResolvedValue(httpResponse(401, { detail: { error: TEST_API_KEY } })), match: { errorCode: 'CONFIGURATION_ERROR', retryable: false, message: 'Web search provider authentication failed.' } },
      { fetch: jest.fn().mockResolvedValue(httpResponse(403, {})), match: { errorCode: 'CONFIGURATION_ERROR', retryable: false, message: 'Web search provider authentication failed.' } },
      { fetch: jest.fn().mockResolvedValue(httpResponse(200, { results: 'bad' })), match: { errorCode: 'INVALID_PROVIDER_RESPONSE', retryable: false, message: 'Web search provider returned an invalid response.' } },
    ];
    for (const item of cases) {
      await expect(new TavilyWebSearchProvider({ fetch: item.fetch } as never, tavilyConfig()).search(query)).rejects.toMatchObject(item.match);
      await expect(new TavilyWebSearchProvider({ fetch: item.fetch } as never, tavilyConfig()).search(query)).rejects.toThrow(expect.not.stringContaining(TEST_API_KEY));
    }
    expect(classifyPipelineError(new Error('Web search provider returned HTTP 500.'))).toMatchObject({ code: 'TRANSIENT_PROVIDER_ERROR', message: 'Web search provider returned HTTP 500.' });
    expect(classifyPipelineError(new Error('Web search provider authentication failed.'))).toMatchObject({ code: 'CONFIGURATION_ERROR', retryable: false });
    expect(classifyPipelineError(new Error('Web search provider rate limit reached.'))).toMatchObject({ code: 'TRANSIENT_PROVIDER_ERROR' });
    expect(classifyPipelineError(new WebSearchError('PROVIDER_HTTP_ERROR', 'tavily', 'search', true, 'Web search provider returned HTTP 500.')).code).not.toBe('INTERNAL_ERROR');
    expect(summarizeJobStates(['failed', 'failed'], 'Web search provider returned HTTP 500.')).toEqual({ state: 'FAILED', message: 'Web search provider returned HTTP 500.' });
  });

  it('does not count the same canonical website twice and stores separate search provenance', () => {
    const engine = new ConflictEngineService();
    const evidence = (provider: string, sourceUrl: string, canonicalUrl: string, excerpt: string): VerificationEvidence => ({
      id: `${provider}-${excerpt}`,
      sourceUrl,
      canonicalUrl,
      sourceType: provider === 'tavily' ? 'WEB_SEARCH' : 'WEBSITE',
      provider,
      evidenceType: 'WEBSITE',
      evidenceText: excerpt,
      metadata: { field: 'website', value: 'https://oak.example/', verified: false },
      retrievedAt: new Date('2026-09-25T16:00:00.000Z'),
    });
    const result = engine.evaluateField({
      field: 'website',
      value: 'https://oak.example/',
      evidence: [
        evidence('tavily', 'https://oak.example/', 'https://oak.example/', 'Oak Stream Investors in Texas'),
        evidence('tavily', 'https://oak.example/about', 'https://oak.example/', 'Oak Stream Investors official site'),
      ],
    }, () => 0);
    expect(result.status).toBe('SUPPORTED');
  });

  it('keeps website discovery idempotent and organization scoped', async () => {
    const fetchPage = jest.fn(async (url: string) => page(url, 'Oak Stream Investors', 'Oak Stream Investors in Texas'));
    const search = { name: 'tavily', search: jest.fn().mockResolvedValue([{ title: 'Oak Stream Investors', url: 'https://oak.example/', snippet: 'Texas', source: 'tavily', retrievedAt: '2026-09-25T16:00:00.000Z' }]) };
    const service = discovery(fetchPage, search);
    const first = await service.discover(company);
    const second = await service.discover(company);
    expect(second.website).toBe(first.website);
    const orgA = `company-enrichment-${createHash('sha256').update('org-a:company-1:execution-1').digest('hex')}`;
    const orgB = `company-enrichment-${createHash('sha256').update('org-b:company-1:execution-1').digest('hex')}`;
    expect(orgA).not.toBe(orgB);

    const discover = jest.fn();
    const findCompanyForOrganization = jest.fn().mockResolvedValue(null);
    const enrichment = new EnrichmentService(
      { select: jest.fn(), insert: jest.fn() } as never,
      {} as never,
      { discover } as never,
      { parsePage: jest.fn() } as never,
      { discover: jest.fn() } as never,
      { findCompanyForOrganization } as never,
      { persistEvidence: jest.fn() } as never,
      { checkRequestRate: jest.fn(), recordUsage: jest.fn() } as never,
      { track: jest.fn() } as never,
    );
    await expect(enrichment.runCompanyEnrichment({ companyId: 'company-1', organizationId: 'org-b' })).rejects.toBeInstanceOf(NotFoundException);
    expect(findCompanyForOrganization).toHaveBeenCalledWith('company-1', 'org-b');
    expect(discover).not.toHaveBeenCalled();
  });

  it('stores search and website provenance without overwriting a verified website or issuing an empty update', async () => {
    const update = jest.fn();
    await expect(new CompanyEnrichmentRepository({ update } as never).updateCompany('company-1', {})).resolves.toBeNull();
    expect(update).not.toHaveBeenCalled();

    const rows: unknown[] = [];
    const database = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => rows.slice(0, 1) }) }) }),
      insert: () => ({ values: (value: unknown) => ({ returning: async () => { rows.push(value); return [value]; } }) }),
    };
    const evidence = new EvidenceRepository(database as never);
    const item = {
      field: 'website',
      value: 'https://oak.example/',
      sourceUrl: 'https://oak.example/',
      evidenceExcerpt: 'Oak Stream Investors',
      retrievedAt: '2026-09-25T16:00:00.000Z',
      evidenceType: 'WEBSITE' as const,
    };
    await evidence.persistEvidence('company-1', item.sourceUrl, [item], item.value, { provider: 'tavily', sourceType: 'WEB_SEARCH', verified: false });
    await evidence.persistEvidence('company-1', item.sourceUrl, [item], item.value, { provider: 'tavily', sourceType: 'WEB_SEARCH', verified: false });
    expect(rows).toHaveLength(1);

    const discover = jest.fn().mockResolvedValue({
      status: 'FOUND',
      website: 'https://other.example/',
      provider: 'tavily',
      sourceUrl: 'https://other.example/',
      sourceType: 'WEBSITE',
      retrievedAt: '2026-09-25T16:00:00.000Z',
      evidenceExcerpt: 'Other',
      searchHit: { title: 'Other', url: 'https://other.example/', snippet: 'Other', source: 'tavily', retrievedAt: '2026-09-25T16:00:00.000Z' },
      pages: [],
    });
    const updateCompany = jest.fn();
    const persistEvidence = jest.fn();
    const row = { id: 'company-1', organizationId: 'org-1', name: 'Oak Stream Investors', website: 'https://existing.example/', description: null, phone: null, email: null, investmentStrategy: null, marketsServed: null, propertyTypes: null, category: 'financial', verificationStatus: 'VERIFIED' };
    const enrichment = new EnrichmentService(
      {
        select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }) }),
        insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) }),
      } as never,
      {} as never,
      { discover } as never,
      { parsePage: jest.fn().mockReturnValue({ evidence: [], description: null, phone: null, publicEmail: null, investmentStrategy: null, marketsServed: [], propertyTypes: [] }) } as never,
      { discover: jest.fn().mockReturnValue([]) } as never,
      {
        findCompanyForOrganization: jest.fn().mockResolvedValue(row),
        findCompanyWithLocation: jest.fn().mockResolvedValue({ company: row, location: { city: null, state: 'Texas', country: 'US' } }),
        updateCompany,
        upsertSocialProfile: jest.fn(),
      } as never,
      { persistEvidence } as never,
      { checkRequestRate: jest.fn(), recordUsage: jest.fn() } as never,
      { track: async (_provider: string, _operation: string, callback: () => Promise<{ value: unknown }>) => (await callback()).value } as never,
    );
    const saved = await enrichment.runCompanyEnrichment({ companyId: 'company-1', organizationId: 'org-1' });
    expect(saved.website).toBe('https://existing.example/');
    expect(updateCompany).not.toHaveBeenCalled();
    expect(persistEvidence).toHaveBeenCalledWith('company-1', 'https://other.example/', [expect.objectContaining({ value: 'https://existing.example/', evidenceExcerpt: 'Other' })], 'https://existing.example/', expect.objectContaining({ provider: 'tavily', sourceType: 'WEB_SEARCH', verified: false }));

    const rejected = jest.fn().mockResolvedValue({
      status: 'NOT_FOUND',
      website: null,
      reason: 'No verified website found for Trinity Investments.',
      sourceUrl: 'https://www.openstreetmap.org/node/1',
      sourceType: 'osm',
      retrievedAt: '2026-09-25T16:00:00.000Z',
      evidenceExcerpt: 'No verified website found for Trinity Investments.',
      clearStoredWebsite: true,
      rejectedSearchHits: [{
        reason: 'DIFFERENT_COMPANY',
        hit: { title: 'TRINITY', url: 'https://startupintros.com/trinity', snippet: 'Trinity Capital is an alternative asset manager.', source: 'tavily', retrievedAt: '2026-09-25T16:00:00.000Z' },
      }],
      pages: [],
    });
    const verified = new EnrichmentService(
      {
        select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }) }),
        insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) }),
      } as never,
      {} as never,
      { discover: rejected } as never,
      { parsePage: jest.fn().mockReturnValue({ evidence: [], description: null, phone: null, publicEmail: null, investmentStrategy: null, marketsServed: [], propertyTypes: [] }) } as never,
      { discover: jest.fn().mockReturnValue([]) } as never,
      {
        findCompanyForOrganization: jest.fn().mockResolvedValue({ ...row, website: 'https://startupintros.com/trinity', verificationStatus: 'VERIFIED' }),
        findCompanyWithLocation: jest.fn().mockResolvedValue({ company: { ...row, website: 'https://startupintros.com/trinity', verificationStatus: 'VERIFIED' }, location: { city: null, state: 'Texas', country: 'US' } }),
        updateCompany,
        upsertSocialProfile: jest.fn(),
      } as never,
      { persistEvidence } as never,
      { checkRequestRate: jest.fn(), recordUsage: jest.fn() } as never,
      { track: async (_provider: string, _operation: string, callback: () => Promise<{ value: unknown }>) => (await callback()).value } as never,
    );
    const kept = await verified.runCompanyEnrichment({ companyId: 'company-1', organizationId: 'org-1' });
    expect(kept.website).toBe('https://startupintros.com/trinity');
    expect(updateCompany).not.toHaveBeenCalled();
  });

  it('rejects third-party search results, keeps the search evidence, and continues with no website', async () => {
    const fetchPage = jest.fn(async (url: string) => {
      if (String(url).includes('startupintros')) return page(url, 'TRINITY: Funding, Team & Investors | Startup Intros', '<p>Trinity Capital is an international alternative asset manager.</p>');
      if (String(url).includes('proxyvote')) return page(url, 'Oak Stream Investors', '<p>founder of Oak Stream Investors</p>');
      throw new Error('Website fetch failed after retries.');
    });
    const retrievedAt = '2026-09-25T16:00:00.000Z';
    const search = {
      name: 'tavily',
      search: jest.fn().mockResolvedValue([
        { title: 'TRINITY', url: 'https://startupintros.com/trinity', snippet: 'Trinity Capital is an alternative asset manager.', source: 'tavily', retrievedAt },
        { title: 'Proxy', url: 'https://materials.proxyvote.com/Approved/1', snippet: 'Oak Stream Investors proxy statement', source: 'tavily', retrievedAt },
        { title: 'Broken', url: 'https://candidate.example/', snippet: 'Oak Stream Investors', source: 'tavily', retrievedAt },
      ]),
    };
    const trinity = await discovery(fetchPage, search).discover({ companyName: 'Trinity Investments', existingWebsite: 'https://startupintros.com/trinity' });
    expect(trinity).toMatchObject({ status: 'NOT_FOUND', website: null, clearStoredWebsite: true });
    expect(trinity.rejectedSearchHits).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'DIFFERENT_COMPANY', hit: expect.objectContaining({ url: 'https://startupintros.com/trinity' }) })]));
    expect(JSON.stringify(trinity)).not.toMatch(/trinityinvestments\.com/i);

    const oak = await discovery(fetchPage, search).discover({ companyName: 'Oak Stream Investors', state: 'Texas' });
    expect(oak.website).toBeNull();
    expect(oak.rejectedSearchHits?.map((item) => item.reason)).toEqual(expect.arrayContaining(['PROXY_OR_FILING', 'UNKNOWN_FETCH_ERROR']));
    expect(fetchPage).not.toHaveBeenCalledWith('https://materials.proxyvote.com/Approved/1');

    const failed = await discovery(fetchPage, search).discover({ companyName: 'Fidelity Investments', state: 'Texas' });
    expect(failed).toMatchObject({ status: 'NOT_FOUND', website: null });
    expect(failed.rejectedSearchHits).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'UNKNOWN_FETCH_ERROR' })]));

    const updateCompany = jest.fn();
    const persistEvidence = jest.fn();
    const stored = { id: 'company-1', organizationId: 'org-1', name: 'Trinity Investments', website: 'https://startupintros.com/trinity', description: null, phone: null, email: null, investmentStrategy: null, marketsServed: null, propertyTypes: null, category: 'financial', verificationStatus: 'NOT_VERIFIED' };
    const enrichment = new EnrichmentService(
      {
        select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([{ sourceUrl: 'https://www.openstreetmap.org/node/1', sourceType: 'osm', rawData: {} }]) }) }),
        insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) }),
      } as never,
      {} as never,
      { discover: jest.fn().mockResolvedValue(trinity) } as never,
      { parsePage: jest.fn().mockReturnValue({ evidence: [], description: null, phone: null, publicEmail: null, investmentStrategy: null, marketsServed: [], propertyTypes: [] }) } as never,
      { discover: jest.fn().mockReturnValue([]) } as never,
      {
        findCompanyForOrganization: jest.fn().mockResolvedValue(stored),
        findCompanyWithLocation: jest.fn().mockResolvedValue({ company: stored, location: null }),
        updateCompany,
        upsertSocialProfile: jest.fn(),
      } as never,
      { persistEvidence } as never,
      { checkRequestRate: jest.fn(), recordUsage: jest.fn() } as never,
      { track: async (_provider: string, _operation: string, callback: () => Promise<{ value: unknown }>) => (await callback()).value } as never,
    );
    const saved = await enrichment.runCompanyEnrichment({ companyId: 'company-1', organizationId: 'org-1' });
    expect(saved).toMatchObject({ website: null, websiteStatus: 'NOT_FOUND' });
    expect(updateCompany).toHaveBeenCalledWith('company-1', { website: null });
    expect(persistEvidence).toHaveBeenCalledWith('company-1', 'https://startupintros.com/trinity', [expect.objectContaining({ value: 'DIFFERENT_COMPANY', evidenceType: 'META_DATA' })], undefined, expect.objectContaining({ provider: 'tavily', sourceType: 'WEB_SEARCH', verified: false }));
  });
});
