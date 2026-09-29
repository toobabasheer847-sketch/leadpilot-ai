import { Injectable, Optional } from '@nestjs/common';
import { MetricsService } from '../../common/observability/metrics.service';
import { RedisService } from '../../redis/redis.service';
import { WebsiteNormalizerService } from '../website/website-normalizer.service';
import type { WebsitePageResult } from '../website/website.types';
import {
  RESEARCH_CONTEXT_MAX_BODY_CHARS,
  RESEARCH_CONTEXT_MAX_PAGES,
  RESEARCH_CONTEXT_TTL_MS,
  type CompanyResearchContext,
  type ResearchContextCompanyFields,
  type ResearchContextKeyParts,
  type ResearchContextPage,
  type ResearchContextPersonHint,
  type ResearchContextSearchHit,
  type ResearchContextStats,
} from './company-research-context.types';

@Injectable()
export class CompanyResearchContextService {
  private readonly memory = new Map<string, { expiresAt: number; context: CompanyResearchContext }>();
  private readonly stats: ResearchContextStats = {
    cacheHits: 0,
    cacheMisses: 0,
    websiteReuseCount: 0,
    providerQueriesAvoided: 0,
    researchContextHits: 0,
    duplicateQueryPrevented: 0,
    additionalQueriesRequired: 0,
    contextsCreated: 0,
  };

  constructor(
    private readonly normalizer: WebsiteNormalizerService,
    private readonly metrics: MetricsService,
    @Optional() private readonly redis?: RedisService,
  ) {}

  getStats(): ResearchContextStats {
    return { ...this.stats };
  }

  resetStatsForTests() {
    this.stats.cacheHits = 0;
    this.stats.cacheMisses = 0;
    this.stats.websiteReuseCount = 0;
    this.stats.providerQueriesAvoided = 0;
    this.stats.researchContextHits = 0;
    this.stats.duplicateQueryPrevented = 0;
    this.stats.additionalQueriesRequired = 0;
    this.stats.contextsCreated = 0;
    this.memory.clear();
  }

  key(parts: ResearchContextKeyParts): string {
    return `research-ctx:${parts.organizationId}:${parts.companyId}:${parts.searchExecutionId ?? 'none'}`;
  }

  normalizeQuery(query: string): string {
    return query.toLowerCase().replace(/\s+/g, ' ').trim();
  }

  async get(parts: ResearchContextKeyParts): Promise<CompanyResearchContext | null> {
    const cacheKey = this.key(parts);
    const local = this.memory.get(cacheKey);
    if (local && local.expiresAt > Date.now()) {
      this.stats.cacheHits += 1;
      this.metrics.increment('research_cache_hits', { layer: 'memory' });
      return cloneContext(local.context);
    }
    const remote = await this.readRedis(cacheKey);
    if (remote) {
      this.memory.set(cacheKey, { expiresAt: Date.now() + RESEARCH_CONTEXT_TTL_MS, context: remote });
      this.stats.cacheHits += 1;
      this.metrics.increment('research_cache_hits', { layer: 'redis' });
      return cloneContext(remote);
    }
    this.stats.cacheMisses += 1;
    this.metrics.increment('research_cache_misses', {});
    return null;
  }

  async getOrCreate(parts: ResearchContextKeyParts, company: ResearchContextCompanyFields = {}): Promise<CompanyResearchContext> {
    const existing = await this.get(parts);
    if (existing) {
      if (company.name || company.website) {
        existing.company = { ...existing.company, ...omitEmpty(company) };
        await this.save(existing);
      }
      return existing;
    }
    const created: CompanyResearchContext = {
      organizationId: parts.organizationId,
      companyId: parts.companyId,
      searchExecutionId: parts.searchExecutionId ?? null,
      company: omitEmpty(company),
      pages: [],
      searchHits: [],
      queriesIssued: [],
      personHints: [],
      updatedAt: new Date().toISOString(),
    };
    this.stats.contextsCreated += 1;
    await this.save(created);
    return created;
  }

  async mergePages(
    parts: ResearchContextKeyParts,
    pages: Array<WebsitePageResult | ResearchContextPage | { url: string; finalUrl?: string; content?: string; html?: string; title?: string | null; contentType?: string; statusCode?: number }>,
    sourceStage: string,
    company?: ResearchContextCompanyFields,
  ): Promise<CompanyResearchContext> {
    const context = await this.getOrCreate(parts, company);
    const byUrl = new Map(context.pages.map((page) => [this.pageKey(page.finalUrl || page.url), page]));
    let reused = 0;
    for (const page of pages) {
      const content = ('content' in page && page.content) || ('html' in page && page.html) || '';
      if (!content || typeof content !== 'string') continue;
      const finalUrl = ('finalUrl' in page && page.finalUrl) || page.url;
      const key = this.pageKey(finalUrl);
      if (!key) continue;
      if (byUrl.has(key)) {
        reused += 1;
        continue;
      }
      byUrl.set(key, {
        url: page.url,
        finalUrl,
        title: ('title' in page ? page.title : null) ?? null,
        content: content.slice(0, RESEARCH_CONTEXT_MAX_BODY_CHARS),
        contentType: ('contentType' in page ? page.contentType : undefined) ?? 'text/html',
        statusCode: ('statusCode' in page ? page.statusCode : undefined) ?? 200,
        fetchedAt: new Date().toISOString(),
        sourceStage,
      });
    }
    context.pages = [...byUrl.values()].slice(0, RESEARCH_CONTEXT_MAX_PAGES);
    if (company) context.company = { ...context.company, ...omitEmpty(company) };
    context.updatedAt = new Date().toISOString();
    if (reused > 0) {
      this.stats.websiteReuseCount += reused;
      for (let i = 0; i < reused; i += 1) this.metrics.increment('website_reuse_count', { stage: sourceStage });
    }
    await this.save(context);
    return cloneContext(context);
  }

  async getPages(parts: ResearchContextKeyParts): Promise<ResearchContextPage[]> {
    const context = await this.get(parts);
    if (!context?.pages.length) return [];
    this.stats.researchContextHits += 1;
    this.metrics.increment('research_context_hits', { kind: 'pages' });
    this.stats.websiteReuseCount += context.pages.length;
    for (let i = 0; i < context.pages.length; i += 1) this.metrics.increment('website_reuse_count', { stage: 'consumer' });
    return context.pages.map((page) => ({ ...page }));
  }

  async recordSearchHits(
    parts: ResearchContextKeyParts,
    query: string,
    hits: Array<{ title: string; url: string; snippet: string; source?: string; provider?: string; retrievedAt?: string }>,
  ): Promise<void> {
    const context = await this.getOrCreate(parts);
    const normalized = this.normalizeQuery(query);
    if (normalized && !context.queriesIssued.includes(normalized)) context.queriesIssued.push(normalized);
    for (const hit of hits) {
      const entry: ResearchContextSearchHit = {
        title: hit.title,
        url: hit.url,
        snippet: hit.snippet,
        provider: hit.provider ?? hit.source ?? 'web_search',
        retrievedAt: hit.retrievedAt ?? new Date().toISOString(),
        query: normalized,
      };
      if (!context.searchHits.some((existing) => existing.url === entry.url && existing.query === entry.query)) {
        context.searchHits.push(entry);
      }
    }
    context.updatedAt = new Date().toISOString();
    await this.save(context);
  }

  async getSearchHits(parts: ResearchContextKeyParts, query?: string): Promise<ResearchContextSearchHit[]> {
    const context = await this.get(parts);
    if (!context?.searchHits.length) return [];
    this.stats.researchContextHits += 1;
    this.metrics.increment('research_context_hits', { kind: 'search_hits' });
    if (!query) return context.searchHits.map((hit) => ({ ...hit }));
    const normalized = this.normalizeQuery(query);
    return context.searchHits.filter((hit) => hit.query === normalized).map((hit) => ({ ...hit }));
  }

  /** Returns true when an equivalent query was already issued for this company/execution. */
  async shouldSkipQuery(parts: ResearchContextKeyParts, query: string): Promise<boolean> {
    const context = await this.get(parts);
    const normalized = this.normalizeQuery(query);
    if (!normalized) return false;
    if (context?.queriesIssued.includes(normalized)) {
      this.stats.duplicateQueryPrevented += 1;
      this.stats.providerQueriesAvoided += 1;
      this.metrics.increment('duplicate_query_prevented', {});
      this.metrics.increment('provider_queries_avoided', {});
      return true;
    }
    // Near-duplicate: same company + same role keyword already searched.
    if (context && this.hasNearDuplicateQuery(context.queriesIssued, normalized)) {
      this.stats.duplicateQueryPrevented += 1;
      this.stats.providerQueriesAvoided += 1;
      this.metrics.increment('duplicate_query_prevented', { kind: 'near' });
      this.metrics.increment('provider_queries_avoided', { kind: 'near' });
      return true;
    }
    this.stats.additionalQueriesRequired += 1;
    this.metrics.increment('additional_queries_required', {});
    return false;
  }

  async markQueryIssued(parts: ResearchContextKeyParts, query: string): Promise<void> {
    const context = await this.getOrCreate(parts);
    const normalized = this.normalizeQuery(query);
    if (normalized && !context.queriesIssued.includes(normalized)) {
      context.queriesIssued.push(normalized);
      context.updatedAt = new Date().toISOString();
      await this.save(context);
    }
  }

  async addPersonHints(parts: ResearchContextKeyParts, hints: ResearchContextPersonHint[]): Promise<void> {
    if (!hints.length) return;
    const context = await this.getOrCreate(parts);
    for (const hint of hints) {
      const key = `${hint.fullName.toLowerCase()}|${(hint.title ?? '').toLowerCase()}|${hint.sourceUrl}`;
      if (context.personHints.some((existing) => `${existing.fullName.toLowerCase()}|${(existing.title ?? '').toLowerCase()}|${existing.sourceUrl}` === key)) continue;
      context.personHints.push(hint);
    }
    context.updatedAt = new Date().toISOString();
    await this.save(context);
  }

  async getPersonHints(parts: ResearchContextKeyParts): Promise<ResearchContextPersonHint[]> {
    const context = await this.get(parts);
    if (!context?.personHints.length) return [];
    this.stats.researchContextHits += 1;
    this.metrics.increment('research_context_hits', { kind: 'person_hints' });
    return context.personHints.map((hint) => ({ ...hint }));
  }

  observeDuration(companyId: string, durationMs: number) {
    this.metrics.observe('per_company_research_duration_ms', durationMs, { company: companyId.slice(0, 8) });
  }

  private hasNearDuplicateQuery(issued: string[], candidate: string): boolean {
    const candidateTokens = significantTokens(candidate);
    if (candidateTokens.length < 2) return false;
    return issued.some((existing) => {
      const existingTokens = significantTokens(existing);
      if (existingTokens.length < 2) return false;
      const overlap = candidateTokens.filter((token) => existingTokens.includes(token));
      // Same company token + overlapping role/intent already searched.
      return overlap.length >= 2 && rolesOverlap(candidate, existing);
    });
  }

  private pageKey(url: string): string | null {
    const normalized = this.normalizer.normalizeUrl(url) ?? url.trim().toLowerCase();
    return normalized || null;
  }

  private async save(context: CompanyResearchContext): Promise<void> {
    const cacheKey = this.key({
      organizationId: context.organizationId,
      companyId: context.companyId,
      searchExecutionId: context.searchExecutionId,
    });
    this.memory.set(cacheKey, { expiresAt: Date.now() + RESEARCH_CONTEXT_TTL_MS, context: cloneContext(context) });
    await this.writeRedis(cacheKey, context);
  }

  private async readRedis(cacheKey: string): Promise<CompanyResearchContext | null> {
    if (!this.redis) return null;
    try {
      const raw = await this.redis.connectionClient().get(cacheKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as CompanyResearchContext;
      if (!parsed?.companyId || !parsed?.organizationId) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private async writeRedis(cacheKey: string, context: CompanyResearchContext): Promise<void> {
    if (!this.redis) return;
    try {
      const ttlSeconds = Math.ceil(RESEARCH_CONTEXT_TTL_MS / 1000);
      await this.redis.connectionClient().set(cacheKey, JSON.stringify(context), 'EX', ttlSeconds);
    } catch {
      // Redis unavailable: memory layer still works in-process.
    }
  }
}

function cloneContext(context: CompanyResearchContext): CompanyResearchContext {
  return {
    ...context,
    company: { ...context.company, aliases: [...(context.company.aliases ?? [])], socialUrls: [...(context.company.socialUrls ?? [])], discoverySourceUrls: [...(context.company.discoverySourceUrls ?? [])] },
    pages: context.pages.map((page) => ({ ...page })),
    searchHits: context.searchHits.map((hit) => ({ ...hit })),
    queriesIssued: [...context.queriesIssued],
    personHints: context.personHints.map((hint) => ({ ...hint })),
  };
}

function omitEmpty(fields: ResearchContextCompanyFields): ResearchContextCompanyFields {
  const next: ResearchContextCompanyFields = {};
  for (const [key, value] of Object.entries(fields) as Array<[keyof ResearchContextCompanyFields, ResearchContextCompanyFields[keyof ResearchContextCompanyFields]]>) {
    if (value == null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (typeof value === 'string' && !value.trim()) continue;
    (next as Record<string, unknown>)[key] = value;
  }
  return next;
}

function significantTokens(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/["']/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !['the', 'and', 'for', 'with', 'from', 'http', 'https', 'www', 'com'].includes(token));
}

function rolesOverlap(left: string, right: string): boolean {
  const roles = ['ceo', 'founder', 'owner', 'president', 'director', 'partner', 'principal', 'managing', 'chief', 'linkedin', 'contact', 'email', 'phone', 'employees', 'staff', 'about', 'team'];
  const leftRoles = roles.filter((role) => left.includes(role));
  const rightRoles = roles.filter((role) => right.includes(role));
  if (!leftRoles.length || !rightRoles.length) return false;
  return leftRoles.some((role) => rightRoles.includes(role));
}
