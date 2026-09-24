import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { DRIZZLE } from '../database/database.constants';
import type { Database } from '../database/database.types';
import { auditLogs, pipelineExecutions, searchExecutions, sourceRecords } from '../database/schema/schema';

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
