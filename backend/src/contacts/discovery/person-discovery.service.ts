import { Inject, Injectable, Optional } from '@nestjs/common';
import { WEB_SEARCH_PROVIDER, type WebSearchProvider } from '../../enrichment/website/web-search.types';
import { CompanyResearchContextService } from '../../enrichment/research-context/company-research-context.service';
import { WebsiteContactProvider } from '../providers/website-contact.provider';
import { SnovContactProvider, prioritizeByRoles } from '../providers/snov-contact.provider';
import { ContactCandidate, ContactDiscoveryContext, ContactDiscoveryResult, CompanyLike } from '../types/contact.types';
import { PersonIdentityMatcherService } from '../matching/person-identity-matcher.service';
import { PersonCandidateService } from './person-candidate.service';
import { assessPublicDecisionMaker, companyDomainFromWebsite, decisionMakerQueries } from './public-decision-maker';
import { isPlausiblePersonName } from '../extraction/person-name';
import { DEFAULT_DECISION_MAKER_ROLES } from '../../search/search-plan.limits';

@Injectable()
export class PersonDiscoveryService {
  constructor(
    private readonly websiteProvider: WebsiteContactProvider,
    private readonly matcher: PersonIdentityMatcherService,
    private readonly candidates: PersonCandidateService,
    private readonly researchContext: CompanyResearchContextService,
    @Optional() private readonly snovProvider?: SnovContactProvider,
    @Optional() @Inject(WEB_SEARCH_PROVIDER) private readonly webSearch?: WebSearchProvider,
  ) {}

  async discover(company: CompanyLike, context: ContactDiscoveryContext): Promise<ContactDiscoveryResult> {
    const started = Date.now();
    const roles = (context.decisionMakerRoles?.length ? context.decisionMakerRoles : [...DEFAULT_DECISION_MAKER_ROLES]);
    const enrichedContext: ContactDiscoveryContext = {
      ...context,
      decisionMakerRoles: roles,
      companyDomain: context.companyDomain ?? companyDomainFromWebsite(company.website ?? context.companyWebsite),
    };
    const contextKey = {
      organizationId: context.organizationId,
      companyId: context.companyId || company.id,
      searchExecutionId: context.searchExecutionId ?? null,
    };

    const candidates: ContactCandidate[] = [];
    let websiteCandidateCount = 0;
    try {
      const websiteResults = await this.websiteProvider.discover(company, enrichedContext);
      const validWebsite = websiteResults.candidates
        .map((candidate) => this.candidates.normalizeCandidate(candidate))
        .filter((candidate) => isPlausiblePersonName(candidate.fullName, company.name));
      websiteCandidateCount = validWebsite.length;
      candidates.push(...validWebsite);
    } catch {
      // One website failure must not abort contact discovery for the company.
    }

    // Seed person hints from research context (deep research / enrichment) without treating them as verified.
    try {
      const hints = await this.researchContext.getPersonHints(contextKey);
      for (const hint of hints) {
        if (!isPlausiblePersonName(hint.fullName, company.name)) continue;
        candidates.push(this.candidates.normalizeCandidate({
          fullName: hint.fullName,
          title: hint.title ?? null,
          companyName: company.name,
          companyRelationship: company.name,
          sourceUrl: hint.sourceUrl,
          evidence: [{
            field: 'fullName',
            value: hint.fullName,
            sourceUrl: hint.sourceUrl,
            evidenceExcerpt: hint.excerpt,
            retrievedAt: new Date().toISOString(),
            evidenceType: 'ABOUT_PAGE',
          }],
          status: 'DISCOVERED',
          verificationStatus: 'NOT_VERIFIED',
        }));
      }
    } catch {
      // Soft — continue with crawl/public search.
    }

    // Always try public web when crawl returned no usable people; also when contact fields are still empty.
    const needsPublic = websiteCandidateCount === 0 || this.needsContactFallback(candidates, enrichedContext);
    if (needsPublic) {
      try {
        candidates.push(...await this.publicCandidates(company.name, roles, company.website ?? context.companyWebsite ?? null, contextKey));
      } catch {
        // Continue with whatever evidence we already have.
      }
    }

    // When crawl/public hits left gaps, run an extra contact-focused web pass before paid providers.
    if (this.needsContactFallback(candidates, enrichedContext)) {
      try {
        candidates.push(...await this.publicContactFallback(company.name, roles, company.website ?? context.companyWebsite ?? null, contextKey));
      } catch {
        // Soft failure — keep partial candidates.
      }
    }

    if (this.needsProviderFallback(candidates, enrichedContext) && this.snovProvider?.configured()) {
      try {
        const providerResults = await this.snovProvider.discover(company, {
          ...enrichedContext,
          allowProviderEnrichment: enrichedContext.allowProviderEnrichment !== false,
        });
        candidates.push(...providerResults.candidates.map((candidate) => this.candidates.normalizeCandidate(candidate)));
      } catch {
        // Provider failures stay soft so company enrichment continues.
      }
    }

    const deduped = this.dedupe(candidates);
    this.researchContext.observeDuration(company.id, Date.now() - started);
    return { candidates: prioritizeByRoles(deduped, roles) };
  }

  private needsProviderFallback(candidates: ContactCandidate[], context: ContactDiscoveryContext): boolean {
    if (context.allowProviderEnrichment === false) return false;
    if (candidates.length === 0) return true;
    if (context.emailRequested && candidates.every((candidate) => !candidate.email)) return true;
    return false;
  }

  private needsContactFallback(candidates: ContactCandidate[], context: ContactDiscoveryContext): boolean {
    if (candidates.length === 0) return true;
    const missingIdentity = candidates.every((candidate) => !candidate.fullName);
    if (missingIdentity) return true;
    const missingContact = candidates.every((candidate) => !candidate.email && !candidate.phone && !candidate.linkedinUrl && !candidate.facebookUrl && !candidate.instagramUrl);
    if (missingContact) return true;
    if (context.emailRequested && candidates.every((candidate) => !candidate.email)) return true;
    const wantsSocial = (context.socialPlatforms?.length ?? 0) > 0 || (context.personFields ?? []).some((field) => /linkedin|facebook|instagram|youtube|twitter|social/i.test(field));
    if (wantsSocial && candidates.every((candidate) => !candidate.linkedinUrl && !candidate.facebookUrl && !candidate.instagramUrl && !candidate.youtubeUrl && !candidate.twitterUrl)) {
      return true;
    }
    return false;
  }

  private async publicCandidates(
    companyName: string,
    roles: string[],
    companyWebsite: string | null,
    contextKey: { organizationId: string; companyId: string; searchExecutionId: string | null },
  ): Promise<ContactCandidate[]> {
    if (!companyName.trim() || typeof this.webSearch?.searchText !== 'function') return [];
    const found: ContactCandidate[] = [];
    const seenQueries = new Set<string>();
    for (const query of decisionMakerQueries(companyName, roles)) {
      const key = query.toLowerCase();
      if (seenQueries.has(key)) continue;
      seenQueries.add(key);
      const hits = await this.searchWithReuse(contextKey, query);
      for (const hit of hits) {
        const candidate = assessPublicDecisionMaker(companyName, hit, {
          allowedRoles: roles,
          companyWebsite,
        });
        if (candidate) found.push(this.candidates.normalizeCandidate(candidate));
      }
    }
    return found;
  }

  private async publicContactFallback(
    companyName: string,
    roles: string[],
    companyWebsite: string | null,
    contextKey: { organizationId: string; companyId: string; searchExecutionId: string | null },
  ): Promise<ContactCandidate[]> {
    if (!companyName.trim() || typeof this.webSearch?.searchText !== 'function') return [];
    const queries = [
      `"${companyName}" contact email phone`,
      `"${companyName}" founder linkedin`,
      `"${companyName}" CEO OR owner "linkedin.com/in"`,
    ];
    const found: ContactCandidate[] = [];
    for (const query of queries) {
      const hits = await this.searchWithReuse(contextKey, query);
      for (const hit of hits) {
        const candidate = assessPublicDecisionMaker(companyName, hit, {
          allowedRoles: roles,
          companyWebsite,
        });
        if (candidate) found.push(this.candidates.normalizeCandidate(candidate));
      }
    }
    return found;
  }

  private async searchWithReuse(
    contextKey: { organizationId: string; companyId: string; searchExecutionId: string | null },
    query: string,
  ): Promise<Array<{ title: string; url: string; snippet: string; source: string; retrievedAt: string }>> {
    if (await this.researchContext.shouldSkipQuery(contextKey, query)) {
      const cached = await this.researchContext.getSearchHits(contextKey, query);
      if (cached.length) {
        return cached.map((hit) => ({
          title: hit.title,
          url: hit.url,
          snippet: hit.snippet,
          source: hit.provider,
          retrievedAt: hit.retrievedAt,
        }));
      }
      // Near-duplicate with no cached hits for this exact query — skip issuing another provider call.
      return [];
    }
    try {
      const searchText = this.webSearch?.searchText?.bind(this.webSearch);
      if (!searchText) return [];
      const hits = await searchText(query, { maxResults: 10 });
      await this.researchContext.markQueryIssued(contextKey, query);
      await this.researchContext.recordSearchHits(contextKey, query, hits);
      return hits.map((hit) => ({
        title: hit.title,
        url: hit.url,
        snippet: hit.snippet,
        source: hit.source,
        retrievedAt: hit.retrievedAt,
      }));
    } catch {
      await this.researchContext.markQueryIssued(contextKey, query);
      return [];
    }
  }

  private dedupe(candidates: ContactCandidate[]): ContactCandidate[] {
    const deduped: ContactCandidate[] = [];
    for (const candidate of candidates) {
      let merged = false;
      for (const existing of deduped) {
        const match = this.matcher.match(existing, candidate);
        if (match.samePerson) {
          existing.evidence.push(...candidate.evidence);
          if (!existing.email && candidate.email) {
            existing.email = candidate.email;
            existing.emailStatus = candidate.emailStatus;
          }
          if (!existing.phone && candidate.phone) {
            existing.phone = candidate.phone;
            existing.phoneStatus = candidate.phoneStatus;
          }
          if (!existing.linkedinUrl && candidate.linkedinUrl) existing.linkedinUrl = candidate.linkedinUrl;
          if (!existing.facebookUrl && candidate.facebookUrl) existing.facebookUrl = candidate.facebookUrl;
          if (!existing.instagramUrl && candidate.instagramUrl) existing.instagramUrl = candidate.instagramUrl;
          if (!existing.youtubeUrl && candidate.youtubeUrl) existing.youtubeUrl = candidate.youtubeUrl;
          if (!existing.twitterUrl && candidate.twitterUrl) existing.twitterUrl = candidate.twitterUrl;
          if (!existing.title && candidate.title) existing.title = candidate.title;
          merged = true;
          break;
        }
      }
      if (!merged) deduped.push(candidate);
    }
    return deduped;
  }
}
