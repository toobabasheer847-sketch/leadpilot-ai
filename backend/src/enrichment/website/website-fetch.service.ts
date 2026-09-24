import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import dns from 'node:dns/promises';
import { isIP } from 'node:net';
import { WebsiteFetchResult } from './website.types';
import { WebsiteNormalizerService } from './website-normalizer.service';

@Injectable()
export class WebsiteFetchService {
  private readonly logger = new Logger(WebsiteFetchService.name);

  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly maxRedirects: number;
  private readonly retries: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly normalizer: WebsiteNormalizerService,
  ) {
    this.timeoutMs = configService.get<number>('website.fetchTimeoutMs', 10000);
    this.maxResponseBytes = configService.get<number>('website.maxResponseBytes', 5000000);
    this.maxRedirects = 5;
    this.retries = 2;
  }

  async fetchPage(url: string): Promise<WebsiteFetchResult> {
    const normalized = this.normalizer.normalizeUrl(url);
    if (!normalized) {
      throw new Error('Invalid website URL.');
    }

    const safeUrl = await this.validatePublicUrl(normalized);
    let currentUrl = safeUrl;
    let redirectCount = 0;

    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      try {
        const response = await this.requestPage(currentUrl);

        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          if (redirectCount >= this.maxRedirects) {
            throw new Error('Too many redirects for website fetch.');
          }

          const nextUrl = this.resolveLocation(currentUrl, response.headers.location);
          const validated = await this.validatePublicUrl(nextUrl);
          redirectCount += 1;
          currentUrl = validated;
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
          canonicalUrl: this.extractCanonicalUrl(body),
          redirectCount,
        };
      } catch (error) {
        if (this.shouldRetry(error) && attempt < this.retries) {
          continue;
        }
        throw error;
      }
    }

    throw new Error('Website fetch failed after retries.');
  }

  private async requestPage(url: string): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

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
      const body = await response.text();
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
    if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
      throw new Error('Localhost targets are blocked.');
    }

    if (hostname === '169.254.169.254' || hostname === 'metadata.google.internal') {
      throw new Error('Cloud metadata targets are blocked.');
    }

    const addresses = await this.resolveHostAddresses(hostname);
    for (const address of addresses) {
      if (this.isBlockedIp(address)) {
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

    if (address === '::1') {
      return true;
    }

    if (address.startsWith('127.')) {
      return true;
    }

    if (address.startsWith('10.')) {
      return true;
    }

    if (address.startsWith('172.16.') || address.startsWith('172.17.') || address.startsWith('172.18.') || address.startsWith('172.19.') || address.startsWith('172.20.') || address.startsWith('172.21.') || address.startsWith('172.22.') || address.startsWith('172.23.') || address.startsWith('172.24.') || address.startsWith('172.25.') || address.startsWith('172.26.') || address.startsWith('172.27.') || address.startsWith('172.28.') || address.startsWith('172.29.') || address.startsWith('172.30.') || address.startsWith('172.31.')) {
      return true;
    }

    if (address.startsWith('192.168.')) {
      return true;
    }

    if (address.startsWith('169.254.')) {
      return true;
    }

    if (address.startsWith('::ffff:127.')) {
      return true;
    }

    return address.startsWith('fc') || address.startsWith('fd') || address.startsWith('fe80') || address.startsWith('2001:db8');
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
