import { Inject, Injectable, Optional } from '@nestjs/common';
import { WEB_SEARCH_PROVIDER, type WebSearchProvider } from '../../enrichment/website/web-search.types';
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
    @Optional() private readonly snovProvider?: SnovContactProvider,
    @Optional() @Inject(WEB_SEARCH_PROVIDER) private readonly webSearch?: WebSearchProvider,
  ) {}

  async discover(company: CompanyLike, context: ContactDiscoveryContext): Promise<ContactDiscoveryResult> {
    const roles = (context.decisionMakerRoles?.length ? context.decisionMakerRoles : [...DEFAULT_DECISION_MAKER_ROLES]);
    const enrichedContext: ContactDiscoveryContext = {
      ...context,
      decisionMakerRoles: roles,
      companyDomain: context.companyDomain ?? companyDomainFromWebsite(company.website ?? context.companyWebsite),
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

    // Always try public web when crawl returned no usable people; also when contact fields are still empty.
    const needsPublic = websiteCandidateCount === 0 || this.needsContactFallback(candidates, enrichedContext);
    if (needsPublic) {
      try {
        candidates.push(...await this.publicCandidates(company.name, roles, company.website ?? context.companyWebsite ?? null));
      } catch {
        // Continue with whatever evidence we already have.
      }
    }

    // When crawl/public hits left gaps, run an extra contact-focused web pass before paid providers.
    if (this.needsContactFallback(candidates, enrichedContext)) {
      try {
        candidates.push(...await this.publicContactFallback(company.name, roles, company.website ?? context.companyWebsite ?? null));
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

  private async publicCandidates(companyName: string, roles: string[], companyWebsite: string | null): Promise<ContactCandidate[]> {
    if (!companyName.trim() || typeof this.webSearch?.searchText !== 'function') return [];
    const found: ContactCandidate[] = [];
    const seenQueries = new Set<string>();
    for (const query of decisionMakerQueries(companyName, roles)) {
      const key = query.toLowerCase();
      if (seenQueries.has(key)) continue;
      seenQueries.add(key);
      try {
        const hits = await this.webSearch.searchText(query, { maxResults: 10 });
        for (const hit of hits) {
          const candidate = assessPublicDecisionMaker(companyName, hit, {
            allowedRoles: roles,
            companyWebsite,
          });
          if (candidate) found.push(this.candidates.normalizeCandidate(candidate));
        }
      } catch {
        continue;
      }
    }
    return found;
  }

  private async publicContactFallback(companyName: string, roles: string[], companyWebsite: string | null): Promise<ContactCandidate[]> {
    if (!companyName.trim() || typeof this.webSearch?.searchText !== 'function') return [];
    const queries = [
      `"${companyName}" contact email phone`,
      `"${companyName}" founder linkedin`,
      `"${companyName}" CEO OR owner "linkedin.com/in"`,
    ];
    const found: ContactCandidate[] = [];
    for (const query of queries) {
      try {
        const hits = await this.webSearch.searchText(query, { maxResults: 10 });
        for (const hit of hits) {
          const candidate = assessPublicDecisionMaker(companyName, hit, {
            allowedRoles: roles,
            companyWebsite,
          });
          if (candidate) found.push(this.candidates.normalizeCandidate(candidate));
        }
      } catch {
        continue;
      }
    }
    return found;
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
