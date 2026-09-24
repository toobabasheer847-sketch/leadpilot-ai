import { Injectable } from '@nestjs/common';
import { WebsiteContactProvider } from '../providers/website-contact.provider';
import { ContactCandidate, ContactDiscoveryContext, ContactDiscoveryResult, CompanyLike } from '../types/contact.types';
import { PersonIdentityMatcherService } from '../matching/person-identity-matcher.service';
import { PersonCandidateService } from './person-candidate.service';

@Injectable()
export class PersonDiscoveryService {
  constructor(
    private readonly websiteProvider: WebsiteContactProvider,
    private readonly matcher: PersonIdentityMatcherService,
    private readonly candidates: PersonCandidateService,
  ) {}

  async discover(company: CompanyLike, context: ContactDiscoveryContext): Promise<ContactDiscoveryResult> {
    const candidates: ContactCandidate[] = [];
    const websiteResults = await this.websiteProvider.discover(company, context);
    candidates.push(...websiteResults.candidates.map((candidate) => this.candidates.normalizeCandidate(candidate)));

    const deduped: ContactCandidate[] = [];
    for (const candidate of candidates) {
      let merged = false;
      for (const existing of deduped) {
        const match = this.matcher.match(existing, candidate);
        if (match.samePerson) {
          existing.evidence.push(...candidate.evidence);
          existing.status = candidate.status;
          existing.verificationStatus = candidate.verificationStatus;
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
}
