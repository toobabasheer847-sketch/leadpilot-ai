import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DRIZZLE } from '../../database/database.constants';
import type { Database } from '../../database/database.types';
import { leadEvidence } from '../../database/schema/schema';
import { ContactCandidate, ContactEvidenceEntry } from '../types/contact.types';

/**
 * Persists discovery evidence only. Final SUPPORTED/VERIFIED status is owned by
 * ContactQuality / VerificationService after multi-source confirmation.
 */
@Injectable()
export class ContactEvidenceService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async persistEvidence(companyId: string, contactId: string, organizationId: string, candidate: ContactCandidate) {
    void organizationId;
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
      const sourceType = item.evidenceType === 'PUBLIC_WEB_SEARCH'
        ? 'PUBLIC_WEB'
        : item.evidenceType === 'PROVIDER_SNOV'
          ? 'PROVIDER'
          : 'WEBSITE';
      const provider = item.evidenceType === 'PUBLIC_WEB_SEARCH'
        ? 'web_search'
        : item.evidenceType === 'PROVIDER_SNOV'
          ? 'snov'
          : 'official_website';
      await this.db.insert(leadEvidence).values({
        companyId,
        contactId,
        evidenceType: item.evidenceType,
        sourceUrl: item.sourceUrl,
        canonicalUrl,
        sourceType,
        provider,
        evidenceText: item.evidenceExcerpt,
        evidenceTimestamp: new Date(item.retrievedAt),
        idempotencyKey,
        metadata: {
          field: item.field,
          value: item.value,
          sourceType,
          sourceUrl: item.sourceUrl,
          retrievedAt: item.retrievedAt,
          evidenceExcerpt: item.evidenceExcerpt,
          discoveryStatus: 'FOUND',
        },
      }).onConflictDoNothing({ target: leadEvidence.idempotencyKey });
    }
  }

  buildEvidenceEntries(values: ContactEvidenceEntry[]): ContactEvidenceEntry[] {
    return values;
  }
}
