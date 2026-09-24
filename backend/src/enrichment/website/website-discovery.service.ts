import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebsiteDiscoveryOutcome } from './website.types';
import { WebsiteFetchService } from './website-fetch.service';
import { WebsiteNormalizerService } from './website-normalizer.service';

@Injectable()
export class WebsiteDiscoveryService {
  constructor(
    private readonly normalizer: WebsiteNormalizerService,
    private readonly fetchService: WebsiteFetchService,
    private readonly config: ConfigService,
  ) {}

  async discover(existingWebsite: string | null | undefined, companyName?: string | null): Promise<WebsiteDiscoveryOutcome> {
    const normalized = this.normalizer.normalizeUrl(existingWebsite ?? null);
    if (!normalized) {
      return { website: null, status: 'NOT_FOUND', reason: companyName ? `No verified website found for ${companyName}.` : 'Website not found.' };
    }

    try {
      const page = await this.fetchService.fetchPage(normalized);
      const pages = [{
        url: normalized,
        finalUrl: page.finalUrl,
        title: page.title ?? null,
        description: page.description ?? null,
        canonicalUrl: page.canonicalUrl ?? null,
        ogTitle: null,
        ogUrl: null,
        content: page.body,
        contentType: page.contentType,
        statusCode: page.statusCode,
        depth: 0,
      }];
      const maxPages = this.config.get<number>('website.maxPagesPerCompany', 5);
      const maxDepth = this.config.get<number>('website.maxCrawlDepth', 1);
      const origin = new URL(page.finalUrl).origin;
      const pending = this.extractInternalLinks(page.body, page.finalUrl)
        .filter((link) => new URL(link).origin === origin)
        .map((url) => ({ url, depth: 1 }));
      const visited = new Set([normalized, page.finalUrl]);
      while (pending.length > 0 && pages.length < maxPages) {
        const next = pending.shift();
        if (!next || visited.has(next.url) || next.depth > maxDepth) continue;
        visited.add(next.url);
        try {
          const linked = await this.fetchService.fetchPage(next.url);
          pages.push({ url: next.url, finalUrl: linked.finalUrl, title: linked.title ?? null, description: linked.description ?? null, canonicalUrl: linked.canonicalUrl ?? null, ogTitle: null, ogUrl: null, content: linked.body, contentType: linked.contentType, statusCode: linked.statusCode, depth: next.depth });
          if (next.depth < maxDepth) {
            for (const child of this.extractInternalLinks(linked.body, linked.finalUrl)) {
              if (new URL(child).origin === origin && !visited.has(child)) pending.push({ url: child, depth: next.depth + 1 });
            }
          }
        } catch {
          continue;
        }
      }
      return {
        website: this.normalizer.normalizeUrl(page.canonicalUrl) ?? normalized,
        status: 'FOUND',
        page: pages[0],
        pages,
      };
    } catch {
      return { website: normalized, status: 'INVALID', reason: 'Website could not be fetched safely.' };
    }
  }

  private extractInternalLinks(html: string, baseUrl: string) {
    const links = new Set<string>();
    for (const match of html.matchAll(/<a[^>]+href=["']([^"']+)["']/gi)) {
      try {
        const resolved = new URL(match[1], baseUrl);
        if (!['http:', 'https:'].includes(resolved.protocol)) continue;
        const normalized = this.normalizer.normalizeUrl(resolved.toString());
        if (normalized) links.add(normalized);
      } catch { continue; }
    }
    return [...links].filter((link) => link !== this.normalizer.normalizeUrl(baseUrl));
  }
}
