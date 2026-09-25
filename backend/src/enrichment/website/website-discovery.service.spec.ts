import { ConfigService } from '@nestjs/config';
import { classifyPipelineError, summarizeJobStates, summarizeWebsiteFindings } from '../../pipeline/pipeline.progress';
import { CompanyEnrichmentRepository } from '../repositories/company-enrichment.repository';
import { EnrichmentService } from '../enrichment.service';
import { WebsiteDiscoveryError } from './website-discovery.error';
import { WebsiteDiscoveryService, websitesFromSourceRaw } from './website-discovery.service';
import { WebsiteNormalizerService } from './website-normalizer.service';

function config(values: Record<string, unknown> = { 'website.fetchTimeoutMs': 1000 }) {
  return {
    get: (key: string, fallback?: unknown) => (Object.prototype.hasOwnProperty.call(values, key) ? values[key] : fallback),
  } as ConfigService;
}

function fetched(url: string) {
  return {
    url,
    finalUrl: url,
    statusCode: 200,
    contentType: 'text/html',
    body: '<html><title>Official</title></html>',
    title: 'Official',
    description: 'Official site',
    canonicalUrl: url,
    redirectCount: 0,
  };
}

function discovery(fetchPage: jest.Mock, values?: Record<string, unknown>) {
  return new WebsiteDiscoveryService(new WebsiteNormalizerService(), { fetchPage } as never, config(values));
}

function company(overrides: Record<string, unknown> = {}) {
  return {
    id: 'company-1',
    organizationId: 'org-1',
    name: 'Oak Stream Investors',
    website: null,
    description: null,
    phone: null,
    email: null,
    investmentStrategy: null,
    marketsServed: null,
    propertyTypes: null,
    verificationStatus: 'NOT_VERIFIED',
    ...overrides,
  };
}

function enrichment(options: {
  discover: jest.Mock;
  row?: ReturnType<typeof company>;
  sources?: unknown[];
  location?: { city: string | null; state: string | null; country: string | null } | null;
}) {
  const row = options.row ?? company();
  const updateCompany = jest.fn();
  const persistEvidence = jest.fn();
  const db = {
    select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(options.sources ?? []) }) }),
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) }),
  };
  const service = new EnrichmentService(
    db as never,
    {} as never,
    { discover: options.discover } as never,
    { parsePage: jest.fn().mockReturnValue({ evidence: [], description: null, phone: null, publicEmail: null, investmentStrategy: null, marketsServed: [], propertyTypes: [] }) } as never,
    { discover: jest.fn().mockReturnValue([]) } as never,
    {
      findCompanyForOrganization: jest.fn().mockResolvedValue(row),
      findCompanyWithLocation: jest.fn().mockResolvedValue({ company: row, location: options.location === undefined ? { city: null, state: 'Texas', country: 'US' } : options.location }),
      updateCompany,
      upsertSocialProfile: jest.fn(),
    } as never,
    { persistEvidence } as never,
    { checkRequestRate: jest.fn(), recordUsage: jest.fn() } as never,
    { track: async (_provider: string, _operation: string, callback: () => Promise<{ value: unknown }>) => (await callback()).value } as never,
  );
  return { service, updateCompany, persistEvidence, discover: options.discover };
}

describe('Website discovery', () => {
  it('finds a website from the stored website provider', async () => {
    const fetchPage = jest.fn().mockImplementation(async (url: string) => fetched(url));
    const service = discovery(fetchPage);
    const result = await service.discover({
      existingWebsite: 'https://oak.example/',
      companyName: 'Oak Stream Investors',
      state: 'Texas',
      sourceWebsites: ['https://fallback.example/'],
    });
    expect(result).toMatchObject({
      status: 'FOUND',
      website: 'https://oak.example/',
      provider: 'stored_website',
      sourceUrl: 'https://oak.example/',
      sourceType: 'WEBSITE',
      evidenceExcerpt: 'Official',
    });
    expect(result.retrievedAt).toEqual(expect.any(String));
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(fetchPage).toHaveBeenCalledWith('https://oak.example/');
  });

  it('finds a website from the next source when the stored website cannot be fetched', async () => {
    const fetchPage = jest.fn().mockImplementation(async (url: string) => {
      if (String(url).includes('missing.example')) throw new Error('Website fetch failed with HTTP 503.');
      return fetched(url);
    });
    const result = await discovery(fetchPage).discover({
      existingWebsite: 'https://missing.example/',
      sourceWebsites: ['https://official.example/'],
      companyName: 'Trinity Investments',
      state: 'Texas',
    });
    expect(result).toMatchObject({ status: 'FOUND', provider: 'source_metadata', website: 'https://official.example/' });
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('returns NOT_FOUND when no legitimate website is available', async () => {
    const fetchPage = jest.fn();
    const result = await discovery(fetchPage).discover({
      companyName: 'Fidelity Investments',
      city: null,
      state: 'Texas',
      country: 'US',
      sourceWebsites: ['Fidelity Investments', 'fidelityinvestments.com', 'https://www.openstreetmap.org/node/1', 'https://maps.google.com/place'],
    });
    expect(result.website).toBeNull();
    expect(result.status).toBe('NOT_FOUND');
    expect(result.reason).toBe('No verified website found for Fidelity Investments in Texas, US.');
    expect(fetchPage).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/fidelityinvestments\.com/i);
  });

  it('reports an unavailable provider instead of inventing a website', async () => {
    const fetchPage = jest.fn().mockRejectedValue(new Error('Website fetch failed after retries.'));
    await expect(discovery(fetchPage).discover({ existingWebsite: 'https://oak.example/', companyName: 'Oak Stream Investors' })).rejects.toMatchObject({
      name: 'WebsiteDiscoveryError',
      errorCode: 'PROVIDER_UNAVAILABLE',
      provider: 'stored_website',
      operation: 'fetch',
      retryable: true,
      message: 'Website discovery provider is unavailable.',
    });
  });

  it('reports a missing provider configuration', async () => {
    const fetchPage = jest.fn();
    await expect(discovery(fetchPage, { 'website.fetchTimeoutMs': undefined }).discover('https://oak.example/', 'Oak Stream Investors')).rejects.toEqual(expect.any(WebsiteDiscoveryError));
    await expect(discovery(fetchPage, { 'website.fetchTimeoutMs': undefined }).discover({ existingWebsite: 'https://oak.example/' })).rejects.toMatchObject({
      errorCode: 'CONFIGURATION_ERROR',
      retryable: false,
      message: 'Website discovery provider is not configured.',
    });
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it('reports a provider timeout', async () => {
    const fetchPage = jest.fn().mockRejectedValue(new Error('The operation was aborted'));
    await expect(discovery(fetchPage).discover({ existingWebsite: 'https://oak.example/' })).rejects.toMatchObject({
      errorCode: 'PROVIDER_TIMEOUT',
      retryable: true,
      message: 'Website discovery provider timed out.',
    });
  });

  it('reports a provider 4xx response', async () => {
    const fetchPage = jest.fn().mockRejectedValue(new Error('Website fetch failed with HTTP 403.'));
    await expect(discovery(fetchPage).discover({ existingWebsite: 'https://oak.example/' })).rejects.toMatchObject({
      errorCode: 'PROVIDER_4XX',
      retryable: false,
      message: 'Website discovery provider returned HTTP 403.',
    });
  });

  it('reports a provider 5xx response', async () => {
    const fetchPage = jest.fn().mockRejectedValue(new Error('Website fetch failed with HTTP 503.'));
    await expect(discovery(fetchPage).discover({ existingWebsite: 'https://oak.example/' })).rejects.toMatchObject({
      errorCode: 'PROVIDER_5XX',
      retryable: true,
      message: 'Website discovery provider returned HTTP 503.',
    });
  });

  it('reports an invalid provider response', async () => {
    const fetchPage = jest.fn().mockRejectedValue(new Error('Unsupported content type: application/octet-stream'));
    await expect(discovery(fetchPage).discover({ existingWebsite: 'https://oak.example/' })).rejects.toMatchObject({
      errorCode: 'INVALID_RESPONSE',
      retryable: false,
      message: 'Website discovery provider returned an invalid response.',
    });
  });

  it('does not generate a website from a company name or directory source', () => {
    expect(websitesFromSourceRaw({
      provider: 'osm',
      tags: { name: 'Oak Stream Investors', office: 'financial' },
      sourceUrl: 'https://www.openstreetmap.org/node/13772227483',
    })).toEqual([]);
    expect(websitesFromSourceRaw({ tags: { website: 'https://oak.example/' }, place: { websiteUri: 'https://maps.google.com/' } })).toEqual(['https://oak.example/', 'https://maps.google.com/']);
  });

  it('does not turn a missing website into an internal pipeline error', async () => {
    const fetchPage = jest.fn();
    const result = await discovery(fetchPage).discover({ companyName: 'Oak Stream Investors', state: 'Texas', attemptSourceUrl: 'https://www.openstreetmap.org/node/13772227483', attemptSourceType: 'osm' });
    expect(result.status).toBe('NOT_FOUND');
    expect(classifyPipelineError(new Error(result.reason ?? '')).code).not.toBe('INTERNAL_ERROR');
    expect(summarizeWebsiteFindings(['NOT_FOUND', 'NOT_FOUND', 'NOT_FOUND'])).toEqual({ state: 'COMPLETED' });
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it('keeps a genuine provider failure failed', async () => {
    await expect(discovery(jest.fn().mockRejectedValue(new Error('Website fetch failed with HTTP 503.'))).discover({ existingWebsite: 'https://oak.example/' })).rejects.toBeInstanceOf(WebsiteDiscoveryError);
    expect(classifyPipelineError(new Error('Website discovery provider returned HTTP 503.'))).toMatchObject({
      code: 'TRANSIENT_PROVIDER_ERROR',
      message: 'Website discovery provider returned HTTP 503.',
      retryable: true,
    });
    expect(summarizeJobStates(['failed', 'failed', 'failed'], 'Website discovery provider returned HTTP 503.')).toEqual({
      state: 'FAILED',
      message: 'Website discovery provider returned HTTP 503.',
    });
    expect(summarizeWebsiteFindings(['FOUND', 'NOT_FOUND'])).toEqual({ state: 'PARTIAL', message: 'No verified website found for some companies.' });
  });

  it('does not issue an empty company update when there is nothing to store', async () => {
    const update = jest.fn();
    const repository = new CompanyEnrichmentRepository({ update } as never);
    await expect(repository.updateCompany('company-1', {})).resolves.toBeNull();
    expect(update).not.toHaveBeenCalled();
  });

  it('does not overwrite an existing website', async () => {
    const discover = jest.fn().mockResolvedValue({
      status: 'FOUND',
      website: 'https://other.example/',
      provider: 'source_metadata',
      sourceUrl: 'https://other.example/',
      sourceType: 'WEBSITE',
      retrievedAt: '2026-09-25T00:00:00.000Z',
      evidenceExcerpt: 'Other site',
      pages: [],
    });
    const { service, updateCompany, persistEvidence } = enrichment({
      discover,
      row: company({ website: 'https://existing.example/' }),
    });
    const result = await service.runCompanyEnrichment({ companyId: 'company-1', organizationId: 'org-1' });
    expect(updateCompany).not.toHaveBeenCalled();
    expect(result.website).toBe('https://existing.example/');
    expect(persistEvidence).toHaveBeenCalledWith('company-1', 'https://other.example/', [expect.objectContaining({ field: 'website', value: 'https://existing.example/' })], 'https://existing.example/', expect.objectContaining({ verified: false }));
  });

  it('stores source provenance for a discovered website and a not-found attempt', async () => {
    const found = jest.fn().mockResolvedValue({
      status: 'FOUND',
      website: 'https://oak.example/',
      provider: 'stored_website',
      sourceUrl: 'https://oak.example/',
      sourceType: 'WEBSITE',
      retrievedAt: '2026-09-25T15:00:00.000Z',
      evidenceExcerpt: 'Oak Stream official site',
      pages: [],
    });
    const foundRun = enrichment({ discover: found, sources: [] });
    await foundRun.service.runCompanyEnrichment({ companyId: 'company-1', organizationId: 'org-1' });
    expect(foundRun.updateCompany).toHaveBeenCalledWith('company-1', { website: 'https://oak.example/' });
    expect(foundRun.persistEvidence).toHaveBeenCalledWith(
      'company-1',
      'https://oak.example/',
      [expect.objectContaining({
        field: 'website',
        value: 'https://oak.example/',
        sourceUrl: 'https://oak.example/',
        evidenceExcerpt: 'Oak Stream official site',
        retrievedAt: '2026-09-25T15:00:00.000Z',
        evidenceType: 'WEBSITE',
      })],
      'https://oak.example/',
      { provider: 'stored_website', sourceType: 'WEBSITE', verified: false },
    );

    const missing = jest.fn().mockResolvedValue({
      status: 'NOT_FOUND',
      website: null,
      provider: null,
      sourceUrl: 'https://www.openstreetmap.org/node/13772227483',
      sourceType: 'osm',
      retrievedAt: '2026-09-25T15:04:00.000Z',
      evidenceExcerpt: 'No verified website found for Oak Stream Investors in Texas, US.',
      reason: 'No verified website found for Oak Stream Investors in Texas, US.',
      pages: [],
    });
    const missingRun = enrichment({
      discover: missing,
      sources: [{ sourceUrl: 'https://www.openstreetmap.org/node/13772227483', sourceType: 'osm', rawData: { tags: { name: 'Oak Stream Investors', website: 'https://official.example/' } } }],
    });
    const result = await missingRun.service.runCompanyEnrichment({ companyId: 'company-1', organizationId: 'org-1' });
    expect(result).toMatchObject({ website: null, websiteStatus: 'NOT_FOUND', message: 'No additional verified enrichment data found.' });
    expect(missingRun.updateCompany).not.toHaveBeenCalled();
    expect(missing).toHaveBeenCalledWith(expect.objectContaining({
      companyName: 'Oak Stream Investors',
      state: 'Texas',
      country: 'US',
      existingWebsite: null,
      sourceWebsites: ['https://official.example/'],
      attemptSourceUrl: 'https://www.openstreetmap.org/node/13772227483',
      attemptSourceType: 'osm',
    }));
    expect(missingRun.persistEvidence).toHaveBeenCalledWith(
      'company-1',
      'https://www.openstreetmap.org/node/13772227483',
      [expect.objectContaining({ field: 'website', value: 'NOT_FOUND', evidenceType: 'META_DATA' })],
      undefined,
      { provider: 'website_discovery', sourceType: 'osm', verified: false },
    );
  });
});
