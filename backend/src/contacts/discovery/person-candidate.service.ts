import { Injectable } from '@nestjs/common';
import type { ContactCandidate } from '../types/contact.types';
import { ContactExtractorService } from '../extraction/contact-extractor.service';

@Injectable()
export class PersonCandidateService {
  constructor(private readonly extractor: ContactExtractorService) {}

  normalizeCandidate(raw: ContactCandidate): ContactCandidate {
    return {
      ...raw,
      fullName: this.extractor.normalizeName(raw.fullName),
      title: raw.title ? this.extractor.normalizeTitle(raw.title) : null,
      email: raw.email ?? null,
      phone: raw.phone ?? null,
     linkedinUrl: raw.linkedinUrl ?? null,
      facebookUrl: raw.facebookUrl ?? null,
      instagramUrl: raw.instagramUrl ?? null,
      normalizedName: raw.fullName.toLowerCase(),
      verificationStatus: raw.verificationStatus ?? 'NOT_VERIFIED',
      status: raw.status ?? 'DISCOVERED',
    };
  }

  attachEvidence(contact: ContactCandidate, sourceUrl: string, field: string, value: string, evidenceType: string): ContactCandidate {
    return {
      ...contact,
      evidence: [
        ...contact.evidence,
        this.extractor.buildEvidence(field, value, sourceUrl, evidenceType),
      ],
    };
  }
}
