import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebsiteDiscoveryError } from './website-discovery.error';
import { evaluateOfficialWebsite, classifyOfficialWebsiteHost, type OfficialWebsiteRejection } from './official-website.validator';
import { isWebsiteFetchFailure, websiteFetchFailureCategory, WebsiteFetchService } from './website-fetch.service';
import { visibleText } from './web-search.query';
import { WEB_SEARCH_PROVIDER } from './web-search.types';
import type { WebSearchProvider, WebSearchResult } from './web-search.types';
import { WebsiteDiscoveryInput, WebsiteDiscoveryOutcome, WebsiteFetchResult } from './website.types';
import { WebsiteNormalizerService } from './website-normalizer.service';

const DIRECTORY_HOSTS = ['openstreetmap.org', 'nominatim.openstreetmap.org', 'overpass-api.de'];
const WEBSITE_TAG_KEYS = ['website', 'contact:website', 'url'] as const;

export function isDirectoryHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^www\./, '');
  return DIRECTORY_HOSTS.some((blocked) => host === blocked || host.endsWith(`.${blocked}`));
}

function isMapHost(url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (host === 'maps.google.com' || host === 'maps.googleapis.com' || host === 'maps.app.goo.gl') return true;
  return (host === 'google.com' || host.endsWith('.google.com')) && url.pathname.toLowerCase().startsWith('/maps');
}

export function websitesFromSourceRaw(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object') return [];
  const record = raw as Record<string, unknown>;
  const tags = record.tags && typeof record.tags === 'object' ? record.tags as Record<string, unknown> : {};
  const place = record.place && typeof record.place === 'object' ? record.place as Record<string, unknown> : {};
  return [
    ...WEBSITE_TAG_KEYS.map((key) => tags[key]),
    place.websiteUri,
    record.website,
  ].filter((value): value is string => typeof value === 'string');
}

@Injectable()
export class WebsiteDiscoveryService {
  constructor(
    private readonly normalizer: WebsiteNormalizerService,
    private readonly fetchService: WebsiteFetchService,
    private readonly config: ConfigService,
    @Optional() @Inject(WEB_SEARCH_PROVIDER) private readonly webSearch?: WebSearchProvider,
  ) {}

  async discover(existingWebsite: string | null | undefined, companyName?: string | null): Promise<WebsiteDiscoveryOutcome>;
  async discover(input: WebsiteDiscoveryInput): Promise<WebsiteDiscoveryOutcome>;
  async discover(existingWebsiteOrInput: string | null | undefined | WebsiteDiscoveryInput, companyName?: string | null): Promise<WebsiteDiscoveryOutcome> {
    const input = this.normalizeInput(existingWebsiteOrInput, companyName);
    const storedHostRejection = this.hostRejection(input.existingWebsite);
    const known = await this.selectCandidates(this.candidates(input), input, false);
    const clearStoredWebsite = Boolean(storedHostRejection) || known.clearStoredWebsite;
    if (known.outcome) return { ...known.outcome, clearStoredWebsite, rejectedSearchHits: known.rejections };
    if (known.failure) throw known.failure;
    if (!this.webSearch) return this.notFound(input, { clearStoredWebsite, rejectedSearchHits: known.rejections });

    const hits = await this.webSearch.search({
      companyName: input.companyName,
      city: input.city,
      state: input.state,
      country: input.country,
      category: input.category,
    });
    const rejectedSearchHits = [...known.rejections];
    const candidates = hits.flatMap((hit) => {
      const reason = this.hostRejection(hit.url);
      if (reason) {
        rejectedSearchHits.push({ reason, hit });
        return [];
      }
      const url = this.acceptOfficialUrl(hit.url);
      return url ? [{ provider: 'web_search', url, hit }] : [];
    });
    const searched = await this.selectCandidates(candidates, input, true);
    rejectedSearchHits.push(...searched.rejections);
    if (searched.outcome) return { ...searched.outcome, clearStoredWebsite, rejectedSearchHits };
    if (searched.failure) throw searched.failure;
    return this.notFound(input, { clearStoredWebsite, rejectedSearchHits });
  }

  private normalizeInput(existingWebsiteOrInput: string | null | undefined | WebsiteDiscoveryInput, companyName?: string | null): WebsiteDiscoveryInput {
    if (existingWebsiteOrInput && typeof existingWebsiteOrInput === 'object') return existingWebsiteOrInput;
    return { existingWebsite: existingWebsiteOrInput ?? null, companyName: companyName ?? null };
  }

  private async selectCandidates(candidates: Array<{ provider: string; url: string; hit?: WebSearchResult }>, input: WebsiteDiscoveryInput, rankMatches: boolean): Promise<{ outcome: WebsiteDiscoveryOutcome | null; failure: WebsiteDiscoveryError | null; clearStoredWebsite: boolean; rejections: NonNullable<WebsiteDiscoveryOutcome['rejectedSearchHits']> }> {
    const rejections: NonNullable<WebsiteDiscoveryOutcome['rejectedSearchHits']> = [];
    if (candidates.length === 0) return { outcome: null, failure: null, clearStoredWebsite: false, rejections };
    this.assertFetchConfigured();
    let failure: WebsiteDiscoveryError | null = null;
    let clearStoredWebsite = false;
    let best: { outcome: WebsiteDiscoveryOutcome; score: number } | null = null;
    for (const candidate of candidates) {
      try {
        const result = await this.fetchCandidate(candidate, input);
        if (result.kind === 'miss') continue;
        if (result.kind === 'rejected') {
          if (candidate.hit) rejections.push({ reason: result.reason, hit: candidate.hit });
          if (candidate.provider === 'stored_website' && result.reason !== 'INSUFFICIENT_COMPANY_MATCH' && result.reason !== 'FETCH_FAILED' && !isWebsiteFetchFailure(result.reason)) clearStoredWebsite = true;
          continue;
        }
        if (!rankMatches) return { outcome: result.outcome, failure: null, clearStoredWebsite, rejections };
        if (!best || result.score > best.score) best = { outcome: result.outcome, score: result.score };
      } catch (error) {
        if (error instanceof WebsiteDiscoveryError) {
          failure ??= error;
          continue;
        }
        throw error;
      }
    }
    if (best) return { outcome: best.outcome, failure: null, clearStoredWebsite, rejections };
    return { outcome: null, failure, clearStoredWebsite, rejections };
  }

  private candidates(input: WebsiteDiscoveryInput): Array<{ provider: string; url: string }> {
    const seen = new Set<string>();
    const list: Array<{ provider: string; url: string }> = [];
    const add = (provider: string, raw?: string | null) => {
      const url = this.acceptOfficialUrl(raw);
      if (!url || seen.has(url)) return;
      seen.add(url);
      list.push({ provider, url });
    };
    add('stored_website', input.existingWebsite);
    for (const url of input.sourceWebsites ?? []) add('source_metadata', url);
    return list;
  }

  private acceptOfficialUrl(raw?: string | null): string | null {
    if (!raw || !/^https?:\/\//i.test(raw.trim())) return null;
    const normalized = this.normalizer.normalizeUrl(raw);
    if (!normalized) return null;
    try {
      const parsed = new URL(normalized);
      if (!parsed.hostname.includes('.') || isDirectoryHost(parsed.hostname) || isMapHost(parsed) || classifyOfficialWebsiteHost(parsed.hostname)) return null;
      return normalized;
    } catch {
      return null;
    }
  }

  private assertFetchConfigured() {
    const timeout = this.config.get<number>('website.fetchTimeoutMs');
    if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) {
      throw new WebsiteDiscoveryError('CONFIGURATION_ERROR', 'website', 'discover', false, 'Website discovery provider is not configured.');
    }
  }

  private async fetchCandidate(candidate: { provider: string; url: string; hit?: WebSearchResult }, input: WebsiteDiscoveryInput): Promise<{ kind: 'outcome'; outcome: WebsiteDiscoveryOutcome; score: number } | { kind: 'miss' } | { kind: 'rejected'; reason: OfficialWebsiteRejection }> {
    let page: WebsiteFetchResult;
    try {
      page = await this.fetchService.fetchPage(candidate.url);
    } catch (error) {
      if (candidate.provider === 'web_search') return { kind: 'rejected', reason: websiteFetchFailureCategory(error) };
      const classified = this.classifyFetchError(error, candidate.provider);
      if (classified === 'miss') return { kind: 'miss' };
      throw classified;
    }

    const early = this.judgeCandidate(candidate, input, page.title ?? candidate.hit?.title ?? '', `${candidate.hit?.snippet ?? ''} ${visibleText(page.body)}`, page.body, page.finalUrl);
    if (candidate.provider === 'web_search' && !early.accepted && early.reason !== 'INSUFFICIENT_COMPANY_MATCH') {
      return { kind: 'rejected', reason: early.reason };
    }

    const pages = [this.pageResult(candidate.url, page, 0)];
    const maxPages = this.config.get<number>('website.maxPagesPerCompany', 5);
    const maxDepth = this.config.get<number>('website.maxCrawlDepth', 1);
    const origin = new URL(page.finalUrl).origin;
    const pending = this.extractInternalLinks(page.body, page.finalUrl)
      .filter((link) => new URL(link).origin === origin)
      .map((url) => ({ url, depth: 1 }));
    const visited = new Set([candidate.url, page.finalUrl]);
    while (pending.length > 0 && pages.length < maxPages) {
      const next = pending.shift();
      if (!next || visited.has(next.url) || next.depth > maxDepth) continue;
      visited.add(next.url);
      try {
        const linked = await this.fetchService.fetchPage(next.url);
        pages.push(this.pageResult(next.url, linked, next.depth));
        if (next.depth < maxDepth) {
          for (const child of this.extractInternalLinks(linked.body, linked.finalUrl)) {
            if (new URL(child).origin === origin && !visited.has(child)) pending.push({ url: child, depth: next.depth + 1 });
          }
        }
      } catch {
        continue;
      }
    }

    const website = this.acceptOfficialUrl(page.canonicalUrl) ?? candidate.url;
    const identity = this.identityText(pages);
    const decision = this.judgeCandidate(candidate, input, identity.title || page.title || candidate.hit?.title || '', `${candidate.hit?.snippet ?? ''} ${identity.text}`, pages.map((item) => item.content).join('\n'), website);
    if (candidate.provider === 'web_search' && !decision.accepted) return { kind: 'rejected', reason: decision.reason };
    if (candidate.provider !== 'web_search' && !decision.accepted && decision.reason !== 'INSUFFICIENT_COMPANY_MATCH') return { kind: 'rejected', reason: decision.reason };
    return {
      kind: 'outcome',
      score: decision.accepted ? decision.score : 1,
      outcome: {
        website,
        status: 'FOUND',
        provider: candidate.hit?.source ?? candidate.provider,
        sourceUrl: page.finalUrl,
        sourceType: 'WEBSITE',
        retrievedAt: candidate.hit?.retrievedAt ?? new Date().toISOString(),
        evidenceExcerpt: this.excerpt(page, website),
        searchHit: candidate.hit ?? null,
        page: pages[0],
        pages,
      },
    };
  }

  private judgeCandidate(candidate: { url: string; hit?: WebSearchResult }, input: WebsiteDiscoveryInput, title: string, text: string, html: string, url: string) {
    return evaluateOfficialWebsite({
      companyName: input.companyName,
      city: input.city,
      state: input.state,
      url,
      title: title || candidate.hit?.title,
      text,
      html,
    });
  }

  private hostRejection(raw?: string | null): OfficialWebsiteRejection | null {
    if (!raw || !/^https?:\/\//i.test(raw.trim())) return null;
    try {
      return classifyOfficialWebsiteHost(new URL(raw).hostname);
    } catch {
      return null;
    }
  }

  private pageResult(url: string, page: WebsiteFetchResult, depth: number) {
    return {
      url,
      finalUrl: page.finalUrl,
      title: page.title ?? null,
      description: page.description ?? null,
      canonicalUrl: page.canonicalUrl ?? null,
      ogTitle: null,
      ogUrl: null,
      content: page.body,
      contentType: page.contentType,
      statusCode: page.statusCode,
      depth,
    };
  }

  private identityText(pages: Array<{ title?: string | null; description?: string | null; content?: string | null }>) {
    return {
      title: pages.map((page) => page.title ?? '').filter(Boolean).join(' '),
      text: pages.map((page) => `${page.description ?? ''} ${visibleText(page.content ?? '')}`).join(' '),
    };
  }

  private excerpt(page: WebsiteFetchResult, website: string) {
    return (page.title?.trim() || page.description?.trim() || website).slice(0, 500);
  }

  private classifyFetchError(error: unknown, provider: string): WebsiteDiscoveryError | 'miss' {
    const message = error instanceof Error ? error.message : 'Website discovery failed.';
    if (/invalid website url|invalid url provided|private or internal|localhost targets|disallowed by robots|only public http/i.test(message)) return 'miss';
    const http = message.match(/HTTP (\d{3})/);
    if (http) {
      const status = Number(http[1]);
      if (status === 404 || status === 410) return 'miss';
      if (status >= 500) return new WebsiteDiscoveryError('PROVIDER_5XX', provider, 'fetch', true, `Website discovery provider returned HTTP ${status}.`);
      if (status === 429) return new WebsiteDiscoveryError('PROVIDER_UNAVAILABLE', provider, 'fetch', true, 'Website discovery provider is unavailable.');
      if (status >= 400) return new WebsiteDiscoveryError('PROVIDER_4XX', provider, 'fetch', false, `Website discovery provider returned HTTP ${status}.`);
    }
    if (/timeout|timed out|abort/i.test(message)) return new WebsiteDiscoveryError('PROVIDER_TIMEOUT', provider, 'fetch', true, 'Website discovery provider timed out.');
    if (/unsupported content type|invalid response|malformed/i.test(message)) return new WebsiteDiscoveryError('INVALID_RESPONSE', provider, 'fetch', false, 'Website discovery provider returned an invalid response.');
    if (/fetch failed|unavailable|econnreset|after retries|transient website/i.test(message)) return new WebsiteDiscoveryError('PROVIDER_UNAVAILABLE', provider, 'fetch', true, 'Website discovery provider is unavailable.');
    return new WebsiteDiscoveryError('PROVIDER_UNAVAILABLE', provider, 'fetch', true, 'Website discovery provider is unavailable.');
  }

  private notFound(input: WebsiteDiscoveryInput, extra?: Pick<WebsiteDiscoveryOutcome, 'clearStoredWebsite' | 'rejectedSearchHits'>): WebsiteDiscoveryOutcome {
    const reason = this.notFoundReason(input);
    return {
      website: null,
      status: 'NOT_FOUND',
      reason,
      provider: null,
      sourceUrl: input.attemptSourceUrl ?? null,
      sourceType: input.attemptSourceType ?? null,
      retrievedAt: new Date().toISOString(),
      evidenceExcerpt: reason,
      clearStoredWebsite: extra?.clearStoredWebsite,
      rejectedSearchHits: extra?.rejectedSearchHits,
    };
  }

  private notFoundReason(input: WebsiteDiscoveryInput) {
    const place = [input.city, input.state, input.country].filter((value): value is string => Boolean(value && value.trim())).join(', ');
    const name = input.companyName?.trim();
    if (name && place) return `No verified website found for ${name} in ${place}.`;
    if (name) return `No verified website found for ${name}.`;
    return 'No verified website found.';
  }

  private extractInternalLinks(html: string, baseUrl: string) {
    const links = new Set<string>();
    for (const match of html.matchAll(/<a[^>]+href=["']([^"']+)["']/gi)) {
      try {
        const resolved = new URL(match[1], baseUrl);
        if (!['http:', 'https:'].includes(resolved.protocol)) continue;
        const normalized = this.normalizer.normalizeUrl(resolved.toString());
        if (normalized) links.add(normalized);
      } catch {
        continue;
      }
    }
    return [...links].filter((link) => link !== this.normalizer.normalizeUrl(baseUrl));
  }
}
