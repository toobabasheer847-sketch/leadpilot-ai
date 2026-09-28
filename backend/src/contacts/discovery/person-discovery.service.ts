import { Inject, Injectable, Optional } from '@nestjs/common';
import { WEB_SEARCH_PROVIDER, type WebSearchProvider } from '../../enrichment/website/web-search.types';
import { WebsiteContactProvider } from '../providers/website-contact.provider';
import { ContactCandidate, ContactDiscoveryContext, ContactDiscoveryResult, CompanyLike } from '../types/contact.types';
import { PersonIdentityMatcherService } from '../matching/person-identity-matcher.service';
import { PersonCandidateService } from './person-candidate.service';
import { assessPublicDecisionMaker, decisionMakerQueries } from './public-decision-maker';

@Injectable()
export class PersonDiscoveryService {
  constructor(
    private readonly websiteProvider: WebsiteContactProvider,
    private readonly matcher: PersonIdentityMatcherService,
    private readonly candidates: PersonCandidateService,
    @Optional() @Inject(WEB_SEARCH_PROVIDER) private readonly webSearch?: WebSearchProvider,
  ) {}

  async discover(company: CompanyLike, context: ContactDiscoveryContext): Promise<ContactDiscoveryResult> {
    const candidates: ContactCandidate[] = [];
    const websiteResults = await this.websiteProvider.discover(company, context);
    candidates.push(...websiteResults.candidates.map((candidate) => this.candidates.normalizeCandidate(candidate)));
    candidates.push(...await this.publicCandidates(company.name));

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
      if (!merged) {
        deduped.push(candidate);
      }
    }

    return { candidates: deduped };
  }

  private async publicCandidates(companyName: string): Promise<ContactCandidate[]> {
    if (!companyName.trim() || typeof this.webSearch?.searchText !== 'function') return [];
    const found: ContactCandidate[] = [];
    for (const query of decisionMakerQueries(companyName)) {
      try {
        const hits = await this.webSearch.searchText(query, { maxResults: 10 });
        for (const hit of hits) {
          const candidate = assessPublicDecisionMaker(companyName, hit);
          if (candidate) found.push(this.candidates.normalizeCandidate(candidate));
        }
      } catch {
        continue;
      }
    }
    return found;
  }
}
