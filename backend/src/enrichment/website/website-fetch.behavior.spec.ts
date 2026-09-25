import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebsiteFetchService } from './website-fetch.service';
import { WebsiteDiscoveryService } from './website-discovery.service';
import { WebsiteNormalizerService } from './website-normalizer.service';

function fetcher(overrides: Record<string, unknown> = {}) {
  const config = { get: (key: string, fallback?: unknown) => ({
    'website.fetchTimeoutMs': 500,
    'website.maxResponseBytes': 100000,
    'website.maxRedirects': 5,
    'website.retries': 0,
    'website.respectRobots': false,
    ...overrides,
  }[key] ?? fallback) } as ConfigService;
  return new WebsiteFetchService(config, new WebsiteNormalizerService());
}

function html(title: string, body = '') {
  return `<html><head><title>${title}</title></head><body>${body}</body></html>`;
}

function page(status: number, body: string, headers: Record<string, string> = { 'content-type': 'text/html' }) {
  return new Response(body, { status, headers });
}

function networkError(code: string) {
  return Object.assign(new Error('fetch failed'), { cause: { code } });
}

function requestedUrl(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  if (typeof Request !== 'undefined' && input instanceof Request) return input.url;
  return '';
}

describe('website fetch behavior', () => {
  afterEach(() => jest.restoreAllMocks());

  it('returns a 200 HTML page for official-site validation', async () => {
    const service = fetcher();
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(page(200, html('Oak Stream Investors', '<p>Oak Stream Investors serves Texas.</p>')));
    const result = await service.fetchPage('https://example.test/?utm_source=ad');
    expect(result.statusCode).toBe(200);
    expect(result.contentType).toContain('text/html');
    expect(result.title).toBe('Oak Stream Investors');
    expect(result.body).toContain('Oak Stream Investors');
    expect(requestedUrl(fetchMock.mock.calls[0][0])).toBe('https://example.test/');
    expect((fetchMock.mock.calls[0][1] as RequestInit).redirect).toBe('manual');
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({ 'User-Agent': expect.stringContaining('LeadPilotBot/1.0') });
  });

  it('keeps HTML metadata when the page is mostly JavaScript', async () => {
    const service = fetcher();
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html><title>Oak Stream Investors</title><script>render()</script></html>', { status: 200 }));
    const result = await service.fetchPage('https://example.test/');
    expect(result.title).toBe('Oak Stream Investors');
    expect(result.contentType).toContain('text/html');
  });

  it('follows a 301 redirect and records the final URL', async () => {
    const service = fetcher();
    const fetchMock = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 301, headers: { location: 'https://example.test/about' } }))
      .mockResolvedValueOnce(page(200, html('Company', '<link rel="canonical" href="https://example.test/about">')));
    const result = await service.fetchPage('https://example.test/');
    expect(result.statusCode).toBe(200);
    expect(result.redirectCount).toBe(1);
    expect(result.finalUrl).toBe('https://example.test/about');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('follows a 302 redirect', async () => {
    const service = fetcher();
    jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/home' } }))
      .mockResolvedValueOnce(page(200, html('Home')));
    const result = await service.fetchPage('https://example.test/');
    expect(result.finalUrl).toBe('https://example.test/home');
    expect(result.redirectCount).toBe(1);
  });

  it('follows 307 and 308 redirects', async () => {
    const service = fetcher();
    const fetchMock = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: '/next' } }))
      .mockResolvedValueOnce(new Response(null, { status: 308, headers: { location: '/done' } }))
      .mockResolvedValueOnce(page(200, html('Done')));
    const result = await service.fetchPage('https://example.test/');
    expect(result.finalUrl).toBe('https://example.test/done');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('preserves www when an apex domain redirects to www', async () => {
    const service = fetcher({ 'website.maxRedirects': 2 });
    const fetchMock = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 301, headers: { location: 'https://www.example.test:443/' } }))
      .mockResolvedValueOnce(page(200, html('Company')));
    const result = await service.fetchPage('https://example.test/');
    expect(requestedUrl(fetchMock.mock.calls[1][0])).toBe('https://www.example.test/');
    expect(new URL(result.finalUrl).hostname).toBe('www.example.test');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('follows www to the apex host', async () => {
    const service = fetcher();
    const fetchMock = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 301, headers: { location: 'https://example.test/' } }))
      .mockResolvedValueOnce(page(200, html('Company')));
    const result = await service.fetchPage('https://www.example.test/');
    expect(requestedUrl(fetchMock.mock.calls[0][0])).toBe('https://www.example.test/');
    expect(requestedUrl(fetchMock.mock.calls[1][0])).toBe('https://example.test/');
    expect(new URL(result.finalUrl).hostname).toBe('example.test');
  });

  it('rejects HTTP 404 and records the failure category', async () => {
    const service = fetcher({ 'website.retries': 2 });
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(page(404, html('Missing')));
    await expect(service.fetchPage('https://example.test/missing?secret=do-not-log')).rejects.toMatchObject({ category: 'HTTP_4XX' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls.at(-1)?.[0]);
    expect(message).toContain('host=example.test');
    expect(message).toContain('scheme=https');
    expect(message).toContain('status=404');
    expect(message).toContain('category=HTTP_4XX');
    expect(message).toContain('timeoutMs=500');
    expect(message).toContain('elapsedMs=');
    expect(message).not.toMatch(/secret|authorization|cookie|api[_-]?key/i);
  });

  it('records HTTP 403 as blocked without retrying', async () => {
    const service = fetcher({ 'website.retries': 2 });
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(page(403, 'blocked', { 'content-type': 'text/html' }));
    await expect(service.fetchPage('https://example.test/')).rejects.toMatchObject({ category: 'BLOCKED' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries HTTP 429 and then records the client error', async () => {
    const service = fetcher({ 'website.retries': 1 });
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(page(429, 'slow down'));
    await expect(service.fetchPage('https://example.test/')).rejects.toMatchObject({ category: 'HTTP_4XX' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries HTTP 500 and then records the server error', async () => {
    const service = fetcher({ 'website.retries': 1 });
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(page(500, 'down'));
    await expect(service.fetchPage('https://example.test/')).rejects.toMatchObject({ category: 'HTTP_5XX' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('uses the configured timeout and retries a timeout', async () => {
    const service = fetcher({ 'website.fetchTimeoutMs': 40, 'website.retries': 1 });
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      (init as RequestInit).signal?.addEventListener('abort', () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })));
    }));
    const started = Date.now();
    await expect(service.fetchPage('https://example.test/')).rejects.toMatchObject({ category: 'FETCH_TIMEOUT' });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('classifies DNS failures and does not retry them', async () => {
    const service = fetcher({ 'website.retries': 2 });
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockRejectedValue(networkError('ENOTFOUND'));
    await expect(service.fetchPage('https://missing.example/')).rejects.toMatchObject({ category: 'DNS_ERROR', networkCode: 'ENOTFOUND' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls.at(-1)?.[0])).toContain('networkCode=ENOTFOUND');
  });

  it('classifies TLS failures and does not retry them', async () => {
    const service = fetcher({ 'website.retries': 2 });
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockRejectedValue(networkError('UNABLE_TO_VERIFY_LEAF_SIGNATURE'));
    await expect(service.fetchPage('https://example.test/')).rejects.toMatchObject({ category: 'TLS_ERROR', networkCode: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects an unsupported content type', async () => {
    const service = fetcher({ 'website.retries': 2 });
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => page(200, 'binary', { 'content-type': 'application/pdf' }));
    await expect(service.fetchPage('https://example.test/file')).rejects.toMatchObject({ category: 'INVALID_CONTENT' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('classifies a redirect loop', async () => {
    const service = fetcher({ 'website.maxRedirects': 1 });
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 302, headers: { location: '/again' } }));
    await expect(service.fetchPage('https://example.test/start')).rejects.toMatchObject({ category: 'REDIRECT_ERROR' });
  });

  it('ignores another crawler disallow-all rule and still honors User-agent star', async () => {
    const service = fetcher({ 'website.respectRobots': true });
    const robots = 'User-agent: BadBot\nDisallow: /\n\nUser-agent: *\nDisallow: /private\n';
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (requestedUrl(url).endsWith('/robots.txt')) return page(200, robots, { 'content-type': 'text/plain' });
      return page(200, html('Allowed'));
    });
    const allowed = await service.fetchPage('https://example.test/about');
    expect(allowed.statusCode).toBe(200);
    await expect(service.fetchPage('https://example.test/private')).rejects.toThrow('robots.txt');
    expect(fetchMock.mock.calls.some((call) => requestedUrl(call[0]).endsWith('/about'))).toBe(true);
  });
});

describe('website discovery after fetch failures', () => {
  afterEach(() => jest.restoreAllMocks());

  function discovery(search: { name: string; search: jest.Mock }) {
    const config = { get: (key: string, fallback?: unknown) => ({
      'website.fetchTimeoutMs': 500,
      'website.maxResponseBytes': 100000,
      'website.maxRedirects': 5,
      'website.retries': 0,
      'website.respectRobots': false,
      'website.maxPagesPerCompany': 1,
    }[key] ?? fallback) } as ConfigService;
    return new WebsiteDiscoveryService(new WebsiteNormalizerService(), fetcher({ 'website.respectRobots': false, 'website.retries': 0 }), config, search);
  }

  const company = { companyName: 'Oak Stream Investors', state: 'Texas', country: 'US' };
  const official = html('Oak Stream Investors', '<p>Oak Stream Investors serves Texas.</p>');

  it('continues to the next search candidate after a fetch failure', async () => {
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (requestedUrl(url).includes('broken')) return page(404, html('Missing'));
      return page(200, official);
    });
    const search = {
      name: 'tavily',
      search: jest.fn().mockResolvedValue([
        { title: 'Missing', url: 'https://broken.example/', snippet: 'Oak Stream Investors', source: 'tavily', retrievedAt: '2026-09-25T16:00:00.000Z' },
        { title: 'Oak Stream Investors', url: 'https://oakstreaminvestors.example/', snippet: 'Oak Stream Investors Texas', source: 'tavily', retrievedAt: '2026-09-25T16:00:00.000Z' },
      ]),
    };
    const result = await discovery(search).discover(company);
    expect(result).toMatchObject({ status: 'FOUND', website: 'https://oakstreaminvestors.example/', provider: 'tavily' });
    expect(result.rejectedSearchHits).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'HTTP_4XX' })]));
  });

  it('stores no official website when every candidate fetch fails', async () => {
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (requestedUrl(url).includes('missing')) return Promise.reject(networkError('ENOTFOUND'));
      return page(503, 'unavailable');
    });
    const search = {
      name: 'tavily',
      search: jest.fn().mockResolvedValue([
        { title: 'Missing', url: 'https://missing.example/', snippet: 'Oak Stream Investors', source: 'tavily', retrievedAt: '2026-09-25T16:00:00.000Z' },
        { title: 'Down', url: 'https://down.example/', snippet: 'Oak Stream Investors', source: 'tavily', retrievedAt: '2026-09-25T16:00:00.000Z' },
      ]),
    };
    const result = await discovery(search).discover(company);
    expect(result).toMatchObject({ status: 'NOT_FOUND', website: null });
    expect(result.rejectedSearchHits?.map((item) => item.reason).sort()).toEqual(['DNS_ERROR', 'HTTP_5XX']);
    expect(result.website).toBeNull();
  });

  it('sends a fetched HTML page to official-site validation', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(page(200, official));
    const search = {
      name: 'tavily',
      search: jest.fn().mockResolvedValue([
        { title: 'Oak Stream Investors', url: 'https://oakstreaminvestors.example/', snippet: 'Oak Stream Investors Texas', source: 'tavily', retrievedAt: '2026-09-25T16:00:00.000Z' },
      ]),
    };
    const result = await discovery(search).discover(company);
    expect(result.status).toBe('FOUND');
    expect(result.website).toBe('https://oakstreaminvestors.example/');
    expect(result.page?.title).toBe('Oak Stream Investors');
    expect(result.page?.content).toContain('serves Texas');
  });
});
