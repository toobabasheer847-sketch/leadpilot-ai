import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { DRIZZLE } from '../../database/database.constants';
import type { Database } from '../../database/database.types';
import { leadEvidence, sourceRecords } from '../../database/schema/schema';
import { SourceEvidence } from '../website/website.types';

@Injectable()
export class EvidenceRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async persistEvidence(companyId: string, sourceUrl: string, evidence: SourceEvidence[], canonicalUrl?: string) {
    const inserted = [] as Array<typeof leadEvidence.$inferSelect>;
    for (const item of evidence) {
      const idempotencyKey = createHash('sha256').update(JSON.stringify({ companyId, field: item.field, sourceUrl: item.sourceUrl || sourceUrl, value: item.value, excerpt: item.evidenceExcerpt })).digest('hex');
      const [existing] = await this.db.select().from(leadEvidence).where(eq(leadEvidence.idempotencyKey, idempotencyKey)).limit(1);
      if (existing) continue;
      const [record] = await this.db.insert(leadEvidence).values({
        companyId,
        evidenceType: item.evidenceType,
        sourceUrl: item.sourceUrl || sourceUrl,
        canonicalUrl: canonicalUrl ?? null,
        sourceType: 'WEBSITE',
        provider: 'official_website',
        evidenceText: item.evidenceExcerpt || item.value,
        evidenceTimestamp: item.retrievedAt ? new Date(item.retrievedAt) : new Date(),
        idempotencyKey,
        metadata: {
          field: item.field,
          value: item.value,
          sourceUrl: item.sourceUrl,
          evidenceType: item.evidenceType,
          sourceType: 'WEBSITE',
          retrievedAt: item.retrievedAt,
          evidenceExcerpt: item.evidenceExcerpt || item.value,
        },
      }).returning();
      if (record) {
        inserted.push(record);
      }
    }
    return inserted;
  }

  async listEvidenceForCompany(companyId: string, organizationId: string) {
    const rows = await this.db.select({
      id: leadEvidence.id,
      evidenceType: leadEvidence.evidenceType,
      sourceUrl: leadEvidence.sourceUrl,
      evidenceText: leadEvidence.evidenceText,
      evidenceTimestamp: leadEvidence.evidenceTimestamp,
      metadata: leadEvidence.metadata,
      createdAt: leadEvidence.createdAt,
    }).from(leadEvidence)
      .innerJoin(sourceRecords, eq(sourceRecords.companyId, leadEvidence.companyId))
      .where(and(
        eq(leadEvidence.companyId, companyId),
        eq(sourceRecords.organizationId, organizationId),
      ));
    return rows;
  }
}
