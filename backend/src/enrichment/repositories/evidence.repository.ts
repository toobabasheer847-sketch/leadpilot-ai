import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE } from '../../database/database.constants';
import type { Database } from '../../database/database.types';
import { leadEvidence, sourceRecords } from '../../database/schema/schema';
import { SourceEvidence } from '../website/website.types';

@Injectable()
export class EvidenceRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async persistEvidence(companyId: string, sourceUrl: string, evidence: SourceEvidence[]) {
    const inserted = [] as Array<typeof leadEvidence.$inferSelect>;
    for (const item of evidence) {
      const [record] = await this.db.insert(leadEvidence).values({
        companyId,
        evidenceType: item.evidenceType,
        sourceUrl: item.sourceUrl || sourceUrl,
        evidenceText: item.evidenceExcerpt || item.value,
        evidenceTimestamp: item.retrievedAt ? new Date(item.retrievedAt) : new Date(),
        metadata: {
          field: item.field,
          value: item.value,
          sourceUrl: item.sourceUrl,
          evidenceType: item.evidenceType,
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
