import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DRIZZLE } from '../../database/database.constants';
import type { Database } from '../../database/database.types';
import { leadEvidence, leadVerifications } from '../../database/schema/schema';
import { ContactCandidate, ContactEvidenceEntry } from '../types/contact.types';

@Injectable()
export class ContactEvidenceService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async persistEvidence(companyId: string, contactId: string, organizationId: string, candidate: ContactCandidate) {
    for (const item of candidate.evidence) {
      const idempotencyKey = createHash('sha256').update(JSON.stringify({ companyId, contactId, field: item.field, sourceUrl: item.sourceUrl, value: item.value, excerpt: item.evidenceExcerpt })).digest('hex');
      const canonicalUrl = (() => {
        try {
          const parsed = new URL(item.sourceUrl);
          parsed.hash = '';
          parsed.hostname = parsed.hostname.replace(/^www\./i, '').toLowerCase();
          return `${parsed.protocol}//${parsed.hostname}`;
        } catch {
          return item.sourceUrl;
        }
      })();
      await this.db.insert(leadEvidence).values({
        companyId,
        contactId,
        evidenceType: item.evidenceType,
        sourceUrl: item.sourceUrl,
        canonicalUrl,
        sourceType: 'WEBSITE',
        provider: 'official_website',
        evidenceText: item.evidenceExcerpt,
        evidenceTimestamp: new Date(item.retrievedAt),
        idempotencyKey,
        metadata: {
          field: item.field,
          value: item.value,
          sourceType: 'WEBSITE',
          sourceUrl: item.sourceUrl,
          retrievedAt: item.retrievedAt,
          evidenceExcerpt: item.evidenceExcerpt,
        },
      }).onConflictDoNothing({ target: leadEvidence.idempotencyKey });
    }

    for (const field of ['fullName', 'title', 'normalizedRole', 'companyRelationship', 'email', 'phone', 'linkedinUrl', 'facebookUrl', 'instagramUrl', 'youtubeUrl']) {
      const candidateFields = candidate as unknown as Record<string, string | null | undefined>;
      const value = field === 'fullName' ? candidate.fullName : field === 'title' ? candidate.title : candidateFields[field] ?? null;
      if (!value) continue;
      await this.db.insert(leadVerifications).values({
        companyId,
        contactId,
        organizationId,
        field: field,
        fieldName: field,
        fieldValue: String(value),
        verificationStatus: candidate.verificationStatus === 'VERIFIED' ? 'VERIFIED' : 'SUPPORTED',
        status: candidate.verificationStatus === 'VERIFIED' ? 'VERIFIED' : 'SUPPORTED',
        verificationType: 'SOURCE_EVIDENCE',
        provider: 'contact-discovery',
        idempotencyKey: `contact-discovery:${contactId}:${field}`,
        verificationSource: candidate.sourceUrl,
        verificationUrl: candidate.sourceUrl,
        verifiedAt: new Date(),
      }).onConflictDoNothing({ target: [leadVerifications.organizationId, leadVerifications.idempotencyKey] });
    }
  }

  buildEvidenceEntries(values: ContactEvidenceEntry[]): ContactEvidenceEntry[] {
    return values;
  }
}
