import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import dns from 'node:dns/promises';
import { isIP } from 'node:net';
import { WebsiteFetchResult } from './website.types';
import { WebsiteNormalizerService } from './website-normalizer.service';

@Injectable()
export class WebsiteFetchService {
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
    const normalized = this.normalizer.normalizeUrl(this.publicHttpsUrl(url));
    if (!normalized) {
      throw new Error('Invalid website URL.');
    }
    const timeoutMs = options?.timeoutMs ?? this.timeoutMs;
    const retries = options?.retries ?? this.retries;

    const safeUrl = await this.validatePublicUrl(normalized);
    if (!(await this.isAllowedByRobots(safeUrl, timeoutMs))) throw new Error('Website disallowed by robots.txt.');
    let currentUrl = safeUrl;
    let redirectCount = 0;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const response = await this.requestPage(currentUrl, timeoutMs);

        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          if (redirectCount >= this.maxRedirects) {
            throw new Error('Too many redirects for website fetch.');
          }

          const nextUrl = this.resolveLocation(currentUrl, response.headers.location);
          const validated = await this.validatePublicUrl(nextUrl);
          if (!(await this.isAllowedByRobots(validated, timeoutMs))) throw new Error('Website disallowed by robots.txt.');
          redirectCount += 1;
          currentUrl = validated;
          attempt -= 1;
          continue;
        }

        if (response.statusCode < 200 || response.statusCode >= 400) {
          throw new Error(`Website fetch failed with HTTP ${response.statusCode}.`);
        }

        const contentType = response.headers['content-type']?.toLowerCase() ?? '';
        if (!this.isAllowedContentType(contentType)) {
          throw new Error(`Unsupported content type: ${contentType || 'unknown'}`);
        }

        const body = response.body;
        if (Buffer.byteLength(body, 'utf8') > this.maxResponseBytes) {
          throw new Error('Website response exceeds configured maximum size.');
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

    throw new Error('Website fetch failed after retries.');
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
      if (response.status >= 300 && response.status < 400) {
        return { statusCode: response.status, headers: { location: response.headers.get('location') ?? '' }, body: '' };
      }
      if (!this.isAllowedContentType(contentTypeHeader)) {
        throw new Error(`Unsupported content type: ${contentTypeHeader || 'unknown'}`);
      }
      const body = await this.readBody(response);
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });

      return {
        statusCode: response.status,
        headers: { ...headers, 'content-type': contentTypeHeader },
        body,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown fetch error';
      if (message.includes('timed out') || message.includes('AbortError') || message.includes('ECONNRESET') || message.includes('fetch failed')) {
        throw new Error(`Transient website fetch failure: ${message}`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private resolveLocation(currentUrl: string, location: string): string {
    const target = new URL(location, currentUrl);
    return target.toString();
  }

  private async validatePublicUrl(url: string): Promise<string> {
    const normalized = this.normalizer.normalizeUrl(url);
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
    if (!(error instanceof Error)) {
      return false;
    }

    const message = error.message.toLowerCase();
    return message.includes('timeout') || message.includes('transient') || message.includes('reset') || message.includes('temporar') || message.includes('503') || message.includes('429');
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
      const rules = (await this.readBody(response)).split(/\r?\n/).map((line) => line.trim()).filter((line) => /^disallow\s*:/i.test(line)).map((line) => line.replace(/^disallow\s*:/i, '').trim()).filter(Boolean);
      this.robotsRules.set(origin, rules);
      return !this.isDisallowedPath(parsed.pathname, rules);
    } catch {
      return true;
    }
  }

  private isDisallowedPath(pathname: string, rules: string[]) {
    return rules.some((rule) => pathname.startsWith(rule));
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
