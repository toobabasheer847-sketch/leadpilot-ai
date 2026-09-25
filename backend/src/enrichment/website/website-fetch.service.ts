import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import dns from 'node:dns/promises';
import { isIP } from 'node:net';
import { WebsiteFetchResult } from './website.types';
import { WebsiteNormalizerService } from './website-normalizer.service';

export type WebsiteFetchFailureCategory =
  | 'FETCH_TIMEOUT'
  | 'DNS_ERROR'
  | 'TLS_ERROR'
  | 'CONNECTION_ERROR'
  | 'HTTP_4XX'
  | 'HTTP_5XX'
  | 'REDIRECT_ERROR'
  | 'INVALID_CONTENT'
  | 'BLOCKED'
  | 'UNKNOWN_FETCH_ERROR';

const FETCH_FAILURES = new Set<WebsiteFetchFailureCategory>([
  'FETCH_TIMEOUT', 'DNS_ERROR', 'TLS_ERROR', 'CONNECTION_ERROR', 'HTTP_4XX', 'HTTP_5XX', 'REDIRECT_ERROR', 'INVALID_CONTENT', 'BLOCKED', 'UNKNOWN_FETCH_ERROR',
]);

export function isWebsiteFetchFailure(reason: string): boolean {
  return FETCH_FAILURES.has(reason as WebsiteFetchFailureCategory);
}

export class WebsiteFetchError extends Error {
  readonly category: WebsiteFetchFailureCategory;
  readonly networkCode: string;

  constructor(message: string, category: WebsiteFetchFailureCategory, networkCode = '') {
    super(message);
    this.name = 'WebsiteFetchError';
    this.category = category;
    this.networkCode = networkCode;
  }
}

export function websiteFetchFailureCategory(error: unknown): WebsiteFetchFailureCategory {
  if (error instanceof WebsiteFetchError) return error.category;
  const message = error instanceof Error ? error.message : '';
  const code = networkCode(error);
  if (/disallowed by robots|http 401|http 403/i.test(message)) return 'BLOCKED';
  if (/too many redirects|redirect/i.test(message) && /redirect/i.test(message)) return 'REDIRECT_ERROR';
  if (/unsupported content type|invalid response|malformed/i.test(message)) return 'INVALID_CONTENT';
  if (/HTTP 5\d\d/i.test(message)) return 'HTTP_5XX';
  if (/HTTP 4\d\d/i.test(message)) return 'HTTP_4XX';
  if (/timeout|timed out|abort/i.test(message) || code === 'ABORT_ERR') return 'FETCH_TIMEOUT';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'DNS_ERROR';
  if (/CERT|TLS|SSL|UNABLE_TO_VERIFY_LEAF_SIGNATURE|HANDSHAKE/i.test(code) || /certificate|tls|ssl/i.test(message)) return 'TLS_ERROR';
  if (/ECONN|EHOSTUNREACH|ENETUNREACH|EPIPE|EAI_FAIL/.test(code) || /ECONN|network|socket/i.test(message)) return 'CONNECTION_ERROR';
  return 'UNKNOWN_FETCH_ERROR';
}

function networkCode(error: unknown): string {
  if (error instanceof WebsiteFetchError && error.networkCode) return error.networkCode;
  const record = error as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = record?.cause?.code ?? record?.code;
  return typeof code === 'string' ? code : '';
}

@Injectable()
export class WebsiteFetchService {
  private readonly logger = new Logger(WebsiteFetchService.name);
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly maxRedirects: number;
  private readonly retries: number;
  private readonly respectRobots: boolean;
  private readonly robotsRules = new Map<string, string[]>();

  constructor(
    private readonly configService: ConfigService,
    private readonly normalizer: WebsiteNormalizerService,
  ) {
    this.timeoutMs = configService.get<number>('website.fetchTimeoutMs', 10000);
    this.maxResponseBytes = configService.get<number>('website.maxResponseBytes', 5000000);
    this.maxRedirects = configService.get<number>('website.maxRedirects', 5);
    this.retries = configService.get<number>('website.retries', 2);
    this.respectRobots = configService.get<boolean>('website.respectRobots', true);
  }

  async fetchPage(url: string, options?: { timeoutMs?: number; retries?: number }): Promise<WebsiteFetchResult> {
    const startedAt = Date.now();
    const normalized = this.requestUrl(this.publicHttpsUrl(url));
    if (!normalized) {
      throw new WebsiteFetchError('Invalid website URL.', 'REDIRECT_ERROR');
    }
    const timeoutMs = options?.timeoutMs ?? this.timeoutMs;
    const retries = options?.retries ?? this.retries;
    let currentUrl = normalized;
    let redirectCount = 0;
    let lastStatus: number | null = null;
    let lastType = '';

    try {
      const safeUrl = await this.validatePublicUrl(normalized);
      if (!(await this.isAllowedByRobots(safeUrl, timeoutMs))) throw new WebsiteFetchError('Website disallowed by robots.txt.', 'BLOCKED');
      currentUrl = safeUrl;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const response = await this.requestPage(currentUrl, timeoutMs);
        lastStatus = response.statusCode;
        lastType = response.headers['content-type'] ?? '';

        if (response.statusCode >= 300 && response.statusCode < 400) {
          if (!response.headers.location || redirectCount >= this.maxRedirects) {
            throw new WebsiteFetchError('Too many redirects for website fetch.', 'REDIRECT_ERROR');
          }

          const nextUrl = this.resolveLocation(currentUrl, response.headers.location);
          const validated = await this.validatePublicUrl(nextUrl);
          if (!(await this.isAllowedByRobots(validated, timeoutMs))) throw new WebsiteFetchError('Website disallowed by robots.txt.', 'BLOCKED');
          redirectCount += 1;
          currentUrl = validated;
          attempt -= 1;
          continue;
        }

        if (response.statusCode === 401 || response.statusCode === 403) {
          throw new WebsiteFetchError(`Website fetch failed with HTTP ${response.statusCode}.`, 'BLOCKED');
        }
        if (response.statusCode === 429) {
          throw new WebsiteFetchError(`Website fetch failed with HTTP ${response.statusCode}.`, 'HTTP_4XX');
        }
        if (response.statusCode >= 500) {
          throw new WebsiteFetchError(`Website fetch failed with HTTP ${response.statusCode}.`, 'HTTP_5XX');
        }
        if (response.statusCode < 200 || response.statusCode >= 400) {
          throw new WebsiteFetchError(`Website fetch failed with HTTP ${response.statusCode}.`, 'HTTP_4XX');
        }

        const headerType = response.headers['content-type']?.toLowerCase() ?? '';
        const contentType = this.isAllowedContentType(headerType) || !this.looksLikeHtml(response.body) ? headerType : 'text/html';
        if (!this.isAllowedContentType(contentType)) {
          throw new WebsiteFetchError(`Unsupported content type: ${contentType || 'unknown'}`, 'INVALID_CONTENT');
        }

        const body = response.body;
        if (Buffer.byteLength(body, 'utf8') > this.maxResponseBytes) {
          throw new WebsiteFetchError('Website response exceeds configured maximum size.', 'INVALID_CONTENT');
        }

        return {
          url: safeUrl,
          finalUrl: currentUrl,
          statusCode: response.statusCode,
          contentType,
          body,
          title: this.extractTitle(body),
          description: this.extractMetaDescription(body),
          canonicalUrl: this.normalizer.normalizeUrl(this.extractCanonicalUrl(body)),
          redirectCount,
        };
      } catch (error) {
        if (this.shouldRetry(error) && attempt < retries) {
          continue;
        }
        throw error;
      }
    }

    throw new WebsiteFetchError('Website fetch failed after retries.', 'UNKNOWN_FETCH_ERROR');
    } catch (error) {
      const category = websiteFetchFailureCategory(error);
      const failure = error instanceof WebsiteFetchError ? error : new WebsiteFetchError(error instanceof Error ? error.message : 'Website fetch failed.', category, networkCode(error));
      this.logFailure(normalized, currentUrl, lastStatus, redirectCount, lastType, failure.category, timeoutMs, networkCode(error), Date.now() - startedAt);
      throw failure;
    }
  }

  private async requestPage(url: string, timeoutMs = this.timeoutMs): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'User-Agent': 'LeadPilotBot/1.0 (+https://leadpilot.ai; public-company-enrichment)',
        },
      });

      const contentTypeHeader = response.headers.get('content-type') ?? '';
      if (response.status < 200 || response.status >= 300) {
        return { statusCode: response.status, headers: { location: response.headers.get('location') ?? '', 'content-type': contentTypeHeader }, body: '' };
      }
      const body = await this.readBody(response);
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        if (key.toLowerCase() === 'set-cookie' || key.toLowerCase() === 'authorization') return;
        headers[key] = value;
      });

      return {
        statusCode: response.status,
        headers: { ...headers, 'content-type': contentTypeHeader },
        body,
      };
    } catch (error) {
      if (error instanceof WebsiteFetchError) throw error;
      const category = websiteFetchFailureCategory(error);
      const code = networkCode(error);
      const message = error instanceof Error ? error.message : 'Unknown fetch error';
      if (category === 'FETCH_TIMEOUT') throw new WebsiteFetchError(`Website fetch timed out: ${message}`, category, code);
      if (category === 'CONNECTION_ERROR') throw new WebsiteFetchError(`Transient website fetch failure: ${message}`, category, code);
      if (category === 'UNKNOWN_FETCH_ERROR' && /fetch failed|ECONNRESET/i.test(message)) {
        throw new WebsiteFetchError(`Transient website fetch failure: ${message}`, 'CONNECTION_ERROR', code);
      }
      throw new WebsiteFetchError(message, category, code);
    } finally {
      clearTimeout(timeout);
    }
  }

  private resolveLocation(currentUrl: string, location: string): string {
    const target = new URL(location, currentUrl);
    return target.toString();
  }

  private async validatePublicUrl(url: string): Promise<string> {
    const normalized = this.requestUrl(url);
    if (!normalized) {
      throw new Error('Invalid URL provided for fetch.');
    }

    const parsed = new URL(normalized);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('Only public http/https targets are allowed.');
    }

    const hostname = parsed.hostname.toLowerCase();
    const loopbackFixture = this.allowsLoopbackFixtures() && (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '127.0.0.1' || hostname === '::1');
    if ((hostname === 'localhost' || hostname.endsWith('.localhost')) && !loopbackFixture) {
      throw new Error('Localhost targets are blocked.');
    }
    if (isIP(hostname) && this.isBlockedIp(hostname) && !(loopbackFixture && this.isLoopbackAddress(hostname))) {
      throw new Error('Blocked private or internal IP.');
    }

    if (hostname === '169.254.169.254' || hostname === 'metadata.google.internal' || hostname === 'metadata') {
      throw new Error('Cloud metadata targets are blocked.');
    }

    const addresses = await this.resolveHostAddresses(hostname);
    for (const address of addresses) {
      if (this.isBlockedIp(address) && !(this.allowsLoopbackFixtures() && this.isLoopbackAddress(address))) {
        throw new Error(`Blocked private or internal IP: ${address}`);
      }
    }

    return normalized;
  }

  private async resolveHostAddresses(hostname: string): Promise<string[]> {
    try {
      const results = await dns.lookup(hostname, { all: true });
      return results.map((entry) => entry.address);
    } catch {
      if (isIP(hostname)) {
        return [hostname];
      }
      return [];
    }
  }

  private isBlockedIp(address: string): boolean {
    if (!isIP(address)) {
      return false;
    }

    if (address === '::1' || address === '::') {
      return true;
    }

    if (address.startsWith('::ffff:')) return this.isBlockedIp(address.slice(7));
    if (address.includes(':')) return address.startsWith('fc') || address.startsWith('fd') || address.startsWith('fe80') || address.startsWith('2001:db8');
    const octets = address.split('.').map(Number);
    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return true;
    const [first, second] = octets;
    return first === 0 || first === 10 || first === 127 || first === 169 && second === 254 || first === 172 && second >= 16 && second <= 31 || first === 192 && second === 0 || first === 192 && second === 168 || first === 198 && (second === 18 || second === 19) || first === 100 && second >= 64 && second <= 127;
  }

  private isAllowedContentType(contentType: string): boolean {
    const normalized = contentType.toLowerCase();
    return normalized.includes('text/html') || normalized.includes('application/xhtml+xml') || normalized.includes('application/xml');
  }

  private shouldRetry(error: unknown): boolean {
    if (error instanceof WebsiteFetchError) {
      return error.category === 'FETCH_TIMEOUT' || error.category === 'CONNECTION_ERROR' || error.category === 'HTTP_5XX' || (error.category === 'HTTP_4XX' && error.message.includes('429'));
    }
    if (!(error instanceof Error)) return false;
    const message = error.message.toLowerCase();
    return message.includes('timeout') || message.includes('timed out') || message.includes('transient') || message.includes('reset') || message.includes('temporar') || /http 5\d\d/.test(message) || message.includes('503') || message.includes('429');
  }

  private async readBody(response: Response): Promise<string> {
    if (!response.body) throw new Error('Website response has no body.');
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      total += chunk.byteLength;
      if (total > this.maxResponseBytes) {
        await reader.cancel();
        throw new Error('Website response exceeds configured maximum size.');
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  private publicHttpsUrl(url: string) {
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.toLowerCase();
      const loopback = host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '::1';
      if (parsed.protocol === 'http:' && !loopback) parsed.protocol = 'https:';
      return parsed.toString();
    } catch {
      return url;
    }
  }

  private allowsLoopbackFixtures() {
    const nodeEnv = this.configService.get<string>('nodeEnv', 'production');
    return nodeEnv === 'development' || nodeEnv === 'test';
  }

  private isLoopbackAddress(address: string) {
    return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
  }

  private async isAllowedByRobots(url: string, timeoutMs = this.timeoutMs): Promise<boolean> {
    if (!this.respectRobots) return true;
    const parsed = new URL(url);
    const origin = parsed.origin;
    const cached = this.robotsRules.get(origin);
    if (cached) return !this.isDisallowedPath(parsed.pathname, cached);
    try {
      const robotsUrl = await this.validatePublicUrl(`${origin}/robots.txt`);
      const response = await fetch(robotsUrl, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error', headers: { 'User-Agent': 'LeadPilotBot/1.0' } });
      if (!response.ok) return true;
      const rules = this.robotsDisallowRules(await this.readBody(response));
      this.robotsRules.set(origin, rules);
      return !this.isDisallowedPath(parsed.pathname, rules);
    } catch {
      return true;
    }
  }

  private isDisallowedPath(pathname: string, rules: string[]) {
    return rules.some((rule) => rule === '/' || pathname.startsWith(rule));
  }

  private robotsDisallowRules(text: string): string[] {
    const groups: Array<{ agents: string[]; rules: string[] }> = [];
    let agents: string[] = [];
    let rules: string[] = [];
    const flush = () => {
      if (agents.length > 0) groups.push({ agents, rules });
      agents = [];
      rules = [];
    };
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.split('#')[0]?.trim() ?? '';
      if (!line) continue;
      const agent = line.match(/^user-agent\s*:\s*(.+)$/i);
      if (agent) {
        if (rules.length > 0) flush();
        agents.push(agent[1].trim().toLowerCase());
        continue;
      }
      const disallow = line.match(/^disallow\s*:\s*(.*)$/i);
      if (disallow && agents.length > 0) rules.push(disallow[1].trim());
    }
    flush();
    const specific = groups.filter((group) => group.agents.some((agent) => agent.includes('leadpilot')));
    const chosen = specific.length > 0 ? specific : groups.filter((group) => group.agents.includes('*'));
    return chosen.flatMap((group) => group.rules).filter(Boolean);
  }

  private requestUrl(url: string): string | null {
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) return null;
      parsed.hash = '';
      parsed.username = '';
      parsed.password = '';
      parsed.hostname = parsed.hostname.toLowerCase();
      if ((parsed.protocol === 'http:' && parsed.port === '80') || (parsed.protocol === 'https:' && parsed.port === '443')) parsed.port = '';
      const parameters = new URLSearchParams();
      const tracking = new Set(['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid']);
      for (const [key, value] of parsed.searchParams.entries()) {
        if (!tracking.has(key.toLowerCase())) parameters.append(key, value);
      }
      parsed.search = parameters.toString();
      if (!parsed.pathname) parsed.pathname = '/';
      return parsed.toString();
    } catch {
      return null;
    }
  }

  private looksLikeHtml(body: string): boolean {
    return /<html|<title|<meta\s/i.test(body.slice(0, 2000));
  }

  private logFailure(requestedUrl: string, currentUrl: string, status: number | null, redirectCount: number, contentType: string, category: WebsiteFetchFailureCategory, timeoutMs: number, code: string, elapsedMs: number) {
    const requested = this.safeUrlParts(requestedUrl);
    const finalHost = this.safeUrlParts(currentUrl);
    this.logger.warn(`website_fetch.failed host=${requested.host} scheme=${requested.scheme} status=${status ?? 'none'} redirects=${redirectCount} finalHost=${finalHost.host} contentType=${contentType || 'none'} category=${category} timeoutMs=${timeoutMs} networkCode=${code || 'none'} elapsedMs=${elapsedMs}`);
  }

  private safeUrlParts(url: string): { host: string; scheme: string } {
    try {
      const parsed = new URL(url);
      return { host: parsed.hostname, scheme: parsed.protocol.replace(':', '') };
    } catch {
      return { host: 'invalid', scheme: 'none' };
    }
  }

  private extractTitle(html: string): string | null {
    const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return match ? match[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() || null : null;
  }

  private extractMetaDescription(html: string): string | null {
    const match = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["'][^>]*>/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["'][^>]*>/i);
    return match ? match[1].trim() || null : null;
  }

  private extractCanonicalUrl(html: string): string | null {
    const match = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["'][^>]*>/i)
      || html.match(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["'][^>]*>/i);
    return match ? match[1].trim() || null : null;
  }
}
