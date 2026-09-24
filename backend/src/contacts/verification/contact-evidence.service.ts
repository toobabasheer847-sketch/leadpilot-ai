import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE } from '../../database/database.constants';
import type { Database } from '../../database/database.types';
import { leadEvidence, leadVerifications } from '../../database/schema/schema';
import { ContactCandidate, ContactEvidenceEntry } from '../types/contact.types';

@Injectable()
export class ContactEvidenceService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async persistEvidence(companyId: string, contactId: string, candidate: ContactCandidate) {
    for (const item of candidate.evidence) {
      await this.db.insert(leadEvidence).values({
        companyId,
        contactId,
        evidenceType: item.evidenceType,
        sourceUrl: item.sourceUrl,
        evidenceText: item.evidenceExcerpt,
        evidenceTimestamp: new Date(item.retrievedAt),
        metadata: {
          field: item.field,
          value: item.value,
        },
      });
    }

    for (const field of ['fullName', 'title', 'email', 'phone', 'linkedinUrl', 'facebookUrl', 'instagramUrl']) {
      const candidateFields = candidate as unknown as Record<string, string | null | undefined>;
      const value = field === 'fullName' ? candidate.fullName : field === 'title' ? candidate.title : candidateFields[field] ?? null;
      if (!value) continue;
      await this.db.insert(leadVerifications).values({
        companyId,
        contactId,
        fieldName: field,
        fieldValue: String(value),
        verificationStatus: candidate.verificationStatus === 'VERIFIED' ? 'VERIFIED' : 'SUPPORTED',
        verificationSource: candidate.sourceUrl,
        verificationUrl: candidate.sourceUrl,
        verifiedAt: new Date(),
      });
    }
  }

  buildEvidenceEntries(values: ContactEvidenceEntry[]): ContactEvidenceEntry[] {
    return values;
  }
}
