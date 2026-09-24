import { ConfigService } from '@nestjs/config';
import { WebsiteFetchService } from './website-fetch.service';
import { WebsiteNormalizerService } from './website-normalizer.service';
import { WebsiteParserService } from './website-parser.service';

function fetcher(overrides: Record<string, unknown> = {}) {
  const config = { get: (key: string, fallback?: unknown) => ({
    'website.fetchTimeoutMs': 500,
    'website.maxResponseBytes': 1000,
    'website.maxRedirects': 2,
    'website.retries': 0,
    'website.respectRobots': false,
    ...overrides,
  }[key] ?? fallback) } as ConfigService;
  return new WebsiteFetchService(config, new WebsiteNormalizerService());
}

describe('Phase 17 website controls', () => {
  afterEach(() => jest.restoreAllMocks());

  it('canonicalizes URLs without discarding source URL responsibility', () => {
    const normalizer = new WebsiteNormalizerService();
    expect(normalizer.normalizeUrl('HTTP://www.Example.com/about/?utm_source=test#team')).toBe('http://example.com/about/');
    expect(normalizer.normalizeUrl('javascript:alert(1)')).toBeNull();
  });

  it('fetches public http websites over https and keeps loopback fixtures on http', async () => {
    const service = fetcher();
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    await service.fetchPage('http://example.test/about');
    expect(fetchMock.mock.calls[0][0]).toBe('https://example.test/about');
    await expect(service.fetchPage('http://127.0.0.1/')).rejects.toThrow('Blocked private or internal IP');
  });

  it('blocks localhost and private IP targets before network access', async () => {
    const service = fetcher();
    await expect(service.fetchPage('http://127.0.0.1/')).rejects.toThrow('Blocked private or internal IP');
    await expect(service.fetchPage('http://10.0.0.1/')).rejects.toThrow('Blocked private or internal IP');
  });

  it('follows bounded redirects and rejects unsupported content', async () => {
    const service = fetcher();
    const fetchMock = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/home' } }))
      .mockResolvedValueOnce(new Response('<html><title>Company</title></html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    const result = await service.fetchPage('https://example.test');
    expect(result.finalUrl).toBe('https://example.test/home');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockResolvedValueOnce(new Response('binary', { status: 200, headers: { 'content-type': 'application/pdf' } }));
    await expect(service.fetchPage('https://example.test/file')).rejects.toThrow('Unsupported content type');
  });

  it('enforces the configured response size limit', async () => {
    const service = fetcher({ 'website.maxResponseBytes': 4 });
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('too large', { status: 200, headers: { 'content-type': 'text/html' } }));
    await expect(service.fetchPage('https://example.test')).rejects.toThrow('exceeds configured maximum size');
  });

  it('honors robots disallow rules when enabled', async () => {
    const service = fetcher({ 'website.respectRobots': true });
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('User-agent: *\nDisallow: /', { status: 200, headers: { 'content-type': 'text/plain' } }));
    await expect(service.fetchPage('https://example.test/private')).rejects.toThrow('robots.txt');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('extracts only public role-based email addresses and legitimate social links', () => {
    const parser = new WebsiteParserService();
    const result = parser.parsePage('https://example.test/about', '<html><title>Company</title><a href="mailto:person@example.test">person</a><a href="mailto:info@example.test">info</a><a href="https://www.linkedin.com/company/company">LinkedIn</a><p>We buy houses for cash.</p></html>');
    expect(result.publicEmail).toBe('info@example.test');
    expect(result.investmentSignals).toEqual(['We buy houses for cash']);
    expect(result.socialLinks).toContain('https://www.linkedin.com/company/company');
  });
});