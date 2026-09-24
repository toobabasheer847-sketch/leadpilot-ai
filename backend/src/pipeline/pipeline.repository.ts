import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import { DRIZZLE } from '../database/database.constants';
import type { Database } from '../database/database.types';
import { auditLogs, companies, companyContacts, leadDuplicates, leadEvidence, leadQualifications, leadVerifications, pipelineExecutions, researchExecutions, searchExecutions, sourceRecords, verificationConflicts } from '../database/schema/schema';
import type { PipelineCounters } from './pipeline.types';

export type PipelineExecutionRow = typeof pipelineExecutions.$inferSelect;

@Injectable()
export class PipelineRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  findActive(organizationId: string, searchId: string) {
    return this.db.select().from(pipelineExecutions).where(and(
      eq(pipelineExecutions.organizationId, organizationId),
      eq(pipelineExecutions.searchId, searchId),
      inArray(pipelineExecutions.status, ['QUEUED', 'RUNNING']),
    )).orderBy(desc(pipelineExecutions.createdAt)).limit(1).then((rows) => rows[0] ?? null);
  }

  findLatest(organizationId: string, searchId: string) {
    return this.db.select().from(pipelineExecutions).where(and(
      eq(pipelineExecutions.organizationId, organizationId),
      eq(pipelineExecutions.searchId, searchId),
    )).orderBy(desc(pipelineExecutions.createdAt)).limit(1).then((rows) => rows[0] ?? null);
  }

  findBySearchExecution(organizationId: string, searchExecutionId: string) {
    return this.db.select().from(pipelineExecutions).where(and(
      eq(pipelineExecutions.organizationId, organizationId),
      eq(pipelineExecutions.searchExecutionId, searchExecutionId),
    )).orderBy(desc(pipelineExecutions.createdAt)).limit(1).then((rows) => rows[0] ?? null);
  }

  findById(organizationId: string, pipelineExecutionId: string) {
    return this.db.select().from(pipelineExecutions).where(and(
      eq(pipelineExecutions.organizationId, organizationId),
      eq(pipelineExecutions.id, pipelineExecutionId),
    )).limit(1).then((rows) => rows[0] ?? null);
  }

  async insert(values: typeof pipelineExecutions.$inferInsert) {
    const [created] = await this.db.insert(pipelineExecutions).values(values).returning();
    return created;
  }

  async update(organizationId: string, pipelineExecutionId: string, values: Partial<typeof pipelineExecutions.$inferInsert>) {
    const [updated] = await this.db.update(pipelineExecutions).set({ ...values, updatedAt: new Date() }).where(and(
      eq(pipelineExecutions.organizationId, organizationId),
      eq(pipelineExecutions.id, pipelineExecutionId),
    )).returning();
    return updated ?? null;
  }

  getSearchExecution(organizationId: string, searchExecutionId: string) {
    return this.db.select().from(searchExecutions).where(and(
      eq(searchExecutions.organizationId, organizationId),
      eq(searchExecutions.id, searchExecutionId),
    )).limit(1).then((rows) => rows[0] ?? null);
  }

  async listCompanyIds(organizationId: string, searchExecutionId: string) {
    const rows = await this.db.select({ companyId: sourceRecords.companyId }).from(sourceRecords).where(and(
      eq(sourceRecords.organizationId, organizationId),
      eq(sourceRecords.searchExecutionId, searchExecutionId),
    )).groupBy(sourceRecords.companyId);
    return rows.flatMap((row) => row.companyId ? [row.companyId] : []);
  }

  async listContactIds(organizationId: string, companyIds: string[]) {
    if (!companyIds.length) return [];
    return this.db.select({ id: companyContacts.id, companyId: companyContacts.companyId }).from(companyContacts)
      .innerJoin(companies, eq(companies.id, companyContacts.companyId))
      .where(and(eq(companies.organizationId, organizationId), inArray(companyContacts.companyId, companyIds)));
  }

  async countEvidence(organizationId: string, companyIds: string[]) {
    return this.countJoined(leadEvidence, organizationId, companyIds);
  }

  async counters(organizationId: string, searchExecutionId: string): Promise<PipelineCounters> {
    const companyIds = await this.listCompanyIds(organizationId, searchExecutionId);
    const [contactsFound, decisionMakersFound, evidenceCollected, verifiedFields, conflictsFound, duplicatesFound, qualifiedLeads, websitesResearched] = await Promise.all([
      this.countContacts(organizationId, companyIds, false),
      this.countContacts(organizationId, companyIds, true),
      this.countEvidence(organizationId, companyIds),
      this.countVerified(organizationId, companyIds),
      this.countConflicts(organizationId, companyIds),
      this.countDuplicates(organizationId, companyIds),
      this.countQualified(organizationId, searchExecutionId),
      this.countResearched(organizationId, companyIds),
    ]);
    return {
      companiesDiscovered: companyIds.length,
      companiesProcessed: companyIds.length,
      websitesResearched,
      decisionMakersFound,
      contactsFound,
      evidenceCollected,
      verifiedFields,
      conflictsFound,
      duplicatesFound,
      qualifiedLeads,
    };
  }

  private async countContacts(organizationId: string, companyIds: string[], namedOnly: boolean) {
    if (!companyIds.length) return 0;
    const filters = [eq(companies.organizationId, organizationId), inArray(companyContacts.companyId, companyIds)];
    if (namedOnly) filters.push(isNotNull(companyContacts.fullName));
    const [row] = await this.db.select({ total: count() }).from(companyContacts).innerJoin(companies, eq(companies.id, companyContacts.companyId)).where(and(...filters));
    return Number(row?.total ?? 0);
  }

  private async countJoined(table: typeof leadEvidence, organizationId: string, companyIds: string[]) {
    if (!companyIds.length) return 0;
    const [row] = await this.db.select({ total: count() }).from(table).innerJoin(companies, eq(companies.id, table.companyId)).where(and(eq(companies.organizationId, organizationId), inArray(table.companyId, companyIds)));
    return Number(row?.total ?? 0);
  }

  private countVerified(organizationId: string, companyIds: string[]) {
    if (!companyIds.length) return Promise.resolve(0);
    return this.db.select({ total: count() }).from(leadVerifications).where(and(
      eq(leadVerifications.organizationId, organizationId),
      inArray(leadVerifications.companyId, companyIds),
      inArray(leadVerifications.status, ['VERIFIED', 'SUPPORTED']),
    )).then((rows) => Number(rows[0]?.total ?? 0));
  }

  private countConflicts(organizationId: string, companyIds: string[]) {
    if (!companyIds.length) return Promise.resolve(0);
    return this.db.select({ total: count() }).from(verificationConflicts).where(and(
      eq(verificationConflicts.organizationId, organizationId),
      inArray(verificationConflicts.companyId, companyIds),
    )).then((rows) => Number(rows[0]?.total ?? 0));
  }

  private countDuplicates(organizationId: string, companyIds: string[]) {
    if (!companyIds.length) return Promise.resolve(0);
    return this.db.select({ total: count() }).from(leadDuplicates).innerJoin(companies, eq(companies.id, leadDuplicates.companyId)).where(and(
      eq(companies.organizationId, organizationId),
      inArray(leadDuplicates.companyId, companyIds),
    )).then((rows) => Number(rows[0]?.total ?? 0));
  }

  private countQualified(organizationId: string, searchExecutionId: string) {
    return this.db.select({ total: count() }).from(leadQualifications).where(and(
      eq(leadQualifications.organizationId, organizationId),
      eq(leadQualifications.searchExecutionId, searchExecutionId),
      eq(leadQualifications.status, 'QUALIFIED'),
    )).then((rows) => Number(rows[0]?.total ?? 0));
  }

  private countResearched(organizationId: string, companyIds: string[]) {
    if (!companyIds.length) return Promise.resolve(0);
    return this.db.select({ total: count() }).from(researchExecutions).where(and(
      eq(researchExecutions.organizationId, organizationId),
      inArray(researchExecutions.companyId, companyIds),
      inArray(researchExecutions.status, ['COMPLETED', 'PARTIAL']),
    )).then((rows) => Number(rows[0]?.total ?? 0));
  }

  async audit(organizationId: string, userId: string | null, action: string, pipelineExecutionId: string, metadata: Record<string, string | null>) {
    await this.db.insert(auditLogs).values({
      organizationId,
      userId,
      action,
      entityType: 'pipeline_execution',
      entityId: pipelineExecutionId,
      metadata,
    });
  }
}
