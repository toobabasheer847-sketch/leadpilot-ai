import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, count, desc, eq, gte, lte } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DRIZZLE } from '../database/database.constants';
import type { Database } from '../database/database.types';
import { auditLogs, exportsTable, searchExecutions } from '../database/schema/schema';
import { LeadsService } from '../leads/leads.service';
import { ListLeadsDto } from '../leads/dto/list-leads.dto';
import type { SearchPlan } from '../search/types/search-plan.types';
import { CreateExportDto } from './dto/create-export.dto';
import { ListExportsDto } from './dto/list-exports.dto';
import { ExportFormatService } from './export-format.service';
import { ExportStorageService } from './export-storage.service';
import { ExportsQueue } from './exports.queue';
import { columnsFromSearchPlan } from './plan-export-columns';
import { applyExportMode, buildExportAuditMetadata, parseStoredExportFilters } from './export-mode';
import { DEFAULT_EXPORT_FIELDS, type ExportField, type ExportJobData, type ExportMode, type ExportStatus, type MissingValueMode } from './types/export.types';
import type { AuthenticatedUser } from '../auth/auth.types';
import { UsageService } from '../usage/usage.service';

@Injectable()
export class ExportsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly leads: LeadsService,
    private readonly queue: ExportsQueue,
    private readonly format: ExportFormatService,
    private readonly storage: ExportStorageService,
    private readonly config: ConfigService,
    private readonly usage: UsageService,
  ) {}

  async create(user: AuthenticatedUser, dto: CreateExportDto) {
    const filters = applyExportMode(dto.filters ?? new ListLeadsDto(), dto.exportMode ?? 'ALL');
    if (filters.searchExecutionId) {
      await this.assertExecutionOwnership(filters.searchExecutionId, user.organizationId);
    }
    const fields = dto.fields?.length
      ? dto.fields
      : await this.resolvePlanFields(user.organizationId, filters.searchExecutionId);
    const missingValueMode: MissingValueMode = dto.missingValueMode ?? 'NOT_FOUND';
    const exportMode: ExportMode = dto.exportMode ?? 'ALL';
    const fingerprint = createHash('sha256').update(JSON.stringify({
      organizationId: user.organizationId,
      requestedByUserId: user.id,
      format: dto.format,
      filters,
      fields,
      exportMode,
      missingValueMode,
    })).digest('hex');
    const [existing] = await this.db.select().from(exportsTable).where(and(
      eq(exportsTable.organizationId, user.organizationId),
      eq(exportsTable.idempotencyKey, fingerprint),
      eq(exportsTable.status, 'QUEUED'),
    )).limit(1);
    if (existing) return { status: existing.status, exportId: existing.id };

    await this.usage.assertDailyQuota(user.organizationId, 'EXPORT');
    const preview = await this.leads.list(user, filters);
    await this.usage.assertMaxExportRows(user.organizationId, preview.pagination.total);

    const storedFilters = Object.assign({}, filters, { exportMode, missingValueMode });
    const [record] = await this.db.insert(exportsTable).values({
      organizationId: user.organizationId,
      requestedByUserId: user.id,
      searchExecutionId: filters.searchExecutionId ?? null,
      format: dto.format,
      status: 'QUEUED',
      filters: storedFilters,
      fields,
      fileName: null,
      filePath: null,
      fileSize: null,
      rowCount: null,
      errorMessage: null,
      idempotencyKey: fingerprint,
      expiresAt: null,
    }).returning();
    if (!record) throw new Error('Export could not be created');

    const job = await this.queue.enqueue({ exportId: record.id, organizationId: user.organizationId });
    await this.audit(user.organizationId, user.id, record.id, 'EXPORT_REQUESTED', buildExportAuditMetadata({
      userId: user.id,
      organizationId: user.organizationId,
      searchExecutionId: filters.searchExecutionId ?? null,
      exportFormat: dto.format,
      exportMode,
      leadCount: preview.pagination.total,
      extra: { fields, jobId: job.id },
    }));
    return { status: 'QUEUED' as const, exportId: record.id, jobId: job.id };
  }

  async process(data: ExportJobData) {
    const [record] = await this.db.select().from(exportsTable).where(and(
      eq(exportsTable.id, data.exportId),
      eq(exportsTable.organizationId, data.organizationId),
    )).limit(1);
    if (!record) throw new NotFoundException('Export not found');

    await this.db.update(exportsTable).set({ status: 'PROCESSING', startedAt: new Date(), updatedAt: new Date() }).where(eq(exportsTable.id, record.id));
    await this.audit(data.organizationId, record.requestedByUserId, record.id, 'EXPORT_STARTED', buildExportAuditMetadata({
      userId: record.requestedByUserId,
      organizationId: data.organizationId,
      searchExecutionId: record.searchExecutionId,
      exportFormat: record.format,
    }));

    try {
      const { filters, exportMode, missingValueMode } = parseStoredExportFilters(record.filters);
      const fields = this.toFields(record.fields);
      const user = { id: record.requestedByUserId, organizationId: data.organizationId } as AuthenticatedUser;
      let rowCount = 0;
      let content: Buffer;

      if (record.format === 'csv') {
        content = await this.buildCsvStreaming(user, filters, fields, missingValueMode, (n) => { rowCount = n; });
      } else {
        const xlsxRows: string[][] = [];
        await this.leads.forEachExportBatch(user, filters, async (leads) => {
          const rows = this.format.toRows(leads as Array<Record<string, unknown>>, fields, missingValueMode);
          rowCount += rows.length;
          xlsxRows.push(...rows);
        });
        content = await this.format.xlsx(fields, xlsxRows);
      }

      const fileName = `leadpilot-export-${record.id}.${record.format}`;
      await this.storage.save(fileName, content);
      const retentionDays = this.config.get<number>('export.retentionDays', 7);
      const expiresAt = new Date(Date.now() + retentionDays * 86400000);
      await this.db.update(exportsTable).set({
        status: 'COMPLETED',
        fileName,
        filePath: fileName,
        fileSize: content.length,
        rowCount,
        completedAt: new Date(),
        expiresAt,
        updatedAt: new Date(),
      }).where(eq(exportsTable.id, record.id));

      await this.usage.recordUsage({
        organizationId: data.organizationId,
        userId: record.requestedByUserId,
        operation: 'EXPORT',
        resourceType: 'export',
        resourceId: record.id,
        units: 1,
        status: 'COMPLETED',
        metadata: { rowCount, fileSize: content.length, exportMode },
      });
      await this.audit(data.organizationId, record.requestedByUserId, record.id, 'EXPORT_COMPLETED', buildExportAuditMetadata({
        userId: record.requestedByUserId,
        organizationId: data.organizationId,
        searchExecutionId: record.searchExecutionId,
        exportFormat: record.format,
        exportMode,
        leadCount: rowCount,
      }));
      return { exportId: record.id, status: 'COMPLETED', rowCount };
    } catch (error) {
      await this.db.update(exportsTable).set({
        status: 'FAILED',
        errorMessage: error instanceof Error ? error.message : 'Export failed',
        updatedAt: new Date(),
      }).where(eq(exportsTable.id, record.id));
      await this.audit(data.organizationId, record.requestedByUserId, record.id, 'EXPORT_FAILED', buildExportAuditMetadata({
        userId: record.requestedByUserId,
        organizationId: data.organizationId,
        searchExecutionId: record.searchExecutionId,
        exportFormat: record.format,
      }));
      throw error;
    }
  }

  async get(id: string, organizationId: string) {
    const record = await this.find(id, organizationId);
    return this.publicRecord(await this.expireIfNeeded(record));
  }

  async list(user: AuthenticatedUser, filters: ListExportsDto) {
    const conditions = [eq(exportsTable.organizationId, user.organizationId)];
    if (filters.status) conditions.push(eq(exportsTable.status, filters.status));
    if (filters.format) conditions.push(eq(exportsTable.format, filters.format));
    if (filters.createdFrom) conditions.push(gte(exportsTable.createdAt, new Date(filters.createdFrom)));
    if (filters.createdTo) conditions.push(lte(exportsTable.createdAt, new Date(filters.createdTo)));
    const where = and(...conditions);
    const [{ total }] = await this.db.select({ total: count() }).from(exportsTable).where(where);
    const rows = await this.db.select().from(exportsTable).where(where).orderBy(desc(exportsTable.createdAt)).limit(filters.limit).offset((filters.page - 1) * filters.limit);
    return {
      data: rows.map((row) => this.publicRecord(row)),
      pagination: { page: filters.page, limit: filters.limit, total: Number(total), totalPages: Math.ceil(Number(total) / filters.limit) },
    };
  }

  async download(id: string, organizationId: string) {
    const record = await this.expireIfNeeded(await this.find(id, organizationId));
    if (record.status !== 'COMPLETED' || !record.fileName) throw new NotFoundException('Export file is not available');
    const content = await this.storage.get(record.fileName);
    await this.audit(organizationId, record.requestedByUserId, record.id, 'EXPORT_DOWNLOADED', buildExportAuditMetadata({
      userId: record.requestedByUserId,
      organizationId,
      searchExecutionId: record.searchExecutionId,
      exportFormat: record.format,
      leadCount: record.rowCount,
    }));
    return { record, content };
  }

  private async buildCsvStreaming(
    user: AuthenticatedUser,
    filters: ListLeadsDto,
    fields: ExportField[],
    missingValueMode: MissingValueMode,
    onCount: (n: number) => void,
  ): Promise<Buffer> {
    const tempDir = join(tmpdir(), 'leadpilot-exports');
    await mkdir(tempDir, { recursive: true });
    const tempPath = join(tempDir, `export-${Date.now()}-${Math.random().toString(36).slice(2)}.csv`);
    const out = createWriteStream(tempPath);
    let rowCount = 0;
    try {
      await writeChunk(out, this.format.csv(fields, [], true));
      await this.leads.forEachExportBatch(user, filters, async (leads) => {
        const rows = this.format.toRows(leads as Array<Record<string, unknown>>, fields, missingValueMode);
        rowCount += rows.length;
        if (rows.length) await writeChunk(out, this.format.csvRows(rows));
      });
      await new Promise<void>((resolve, reject) => out.end((error: Error | null | undefined) => (error ? reject(error) : resolve())));
      onCount(rowCount);
      return await readFile(tempPath);
    } finally {
      await unlink(tempPath).catch(() => undefined);
    }
  }

  private async resolvePlanFields(organizationId: string, searchExecutionId?: string): Promise<ExportField[]> {
    if (!searchExecutionId) return [...DEFAULT_EXPORT_FIELDS];
    const [execution] = await this.db.select({
      structuredPlan: searchExecutions.structuredPlan,
      organizationId: searchExecutions.organizationId,
    }).from(searchExecutions).where(and(
      eq(searchExecutions.id, searchExecutionId),
      eq(searchExecutions.organizationId, organizationId),
    )).limit(1);
    if (!execution) throw new ForbiddenException('Search execution is not available for this organization');
    return columnsFromSearchPlan(execution.structuredPlan as SearchPlan | null);
  }

  private async assertExecutionOwnership(searchExecutionId: string, organizationId: string) {
    const [execution] = await this.db.select({ id: searchExecutions.id }).from(searchExecutions).where(and(
      eq(searchExecutions.id, searchExecutionId),
      eq(searchExecutions.organizationId, organizationId),
    )).limit(1);
    if (!execution) throw new ForbiddenException('Search execution is not available for this organization');
  }

  private async find(id: string, organizationId: string) {
    const [record] = await this.db.select().from(exportsTable).where(and(eq(exportsTable.id, id), eq(exportsTable.organizationId, organizationId))).limit(1);
    if (!record) throw new NotFoundException('Export not found');
    return record;
  }

  private async expireIfNeeded(record: typeof exportsTable.$inferSelect) {
    if (record.status !== 'EXPIRED' && record.expiresAt && record.expiresAt <= new Date()) {
      if (record.fileName) await this.storage.delete(record.fileName);
      const [updated] = await this.db.update(exportsTable).set({ status: 'EXPIRED', updatedAt: new Date() }).where(eq(exportsTable.id, record.id)).returning();
      await this.audit(record.organizationId, null, record.id, 'EXPORT_EXPIRED', { exportId: record.id, organizationId: record.organizationId, timestamp: new Date().toISOString() });
      return updated ?? { ...record, status: 'EXPIRED' as ExportStatus };
    }
    return record;
  }

  private toFields(value: unknown): ExportField[] {
    return Array.isArray(value) ? value.filter((field): field is ExportField => typeof field === 'string') : DEFAULT_EXPORT_FIELDS;
  }

  private publicRecord(record: typeof exportsTable.$inferSelect) {
    return {
      id: record.id,
      format: record.format,
      status: record.status,
      rowCount: record.rowCount,
      fileSize: record.fileSize,
      fileName: record.fileName,
      searchExecutionId: record.searchExecutionId,
      createdAt: record.createdAt,
      completedAt: record.completedAt,
      expiresAt: record.expiresAt,
      errorMessage: record.errorMessage,
    };
  }

  private audit(organizationId: string, userId: string | null, entityId: string, action: string, metadata: unknown) {
    return this.db.insert(auditLogs).values({ organizationId, userId, entityId, action, entityType: 'export', metadata });
  }
}

function writeChunk(stream: NodeJS.WritableStream, chunk: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(chunk, (error) => (error ? reject(error) : resolve()));
  });
}
