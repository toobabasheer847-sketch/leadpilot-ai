import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, count, desc, eq, gte, lte } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { DRIZZLE } from '../database/database.constants';
import type { Database } from '../database/database.types';
import { auditLogs, exportsTable } from '../database/schema/schema';
import { LeadsService } from '../leads/leads.service';
import { ListLeadsDto } from '../leads/dto/list-leads.dto';
import { CreateExportDto } from './dto/create-export.dto';
import { ListExportsDto } from './dto/list-exports.dto';
import { ExportFormatService } from './export-format.service';
import { ExportStorageService } from './export-storage.service';
import { ExportsQueue } from './exports.queue';
import { DEFAULT_EXPORT_FIELDS, type ExportField, type ExportJobData, type ExportStatus } from './types/export.types';
import type { AuthenticatedUser } from '../auth/auth.types';

@Injectable()
export class ExportsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly leads: LeadsService,
    private readonly queue: ExportsQueue,
    private readonly format: ExportFormatService,
    private readonly storage: ExportStorageService,
    private readonly config: ConfigService,
  ) {}

  async create(user: AuthenticatedUser, dto: CreateExportDto) {
    const fields = dto.fields?.length ? dto.fields : DEFAULT_EXPORT_FIELDS;
    const filters = dto.filters ?? new ListLeadsDto();
    const fingerprint = createHash('sha256').update(JSON.stringify({ organizationId: user.organizationId, requestedByUserId: user.id, format: dto.format, filters, fields })).digest('hex');
    const [existing] = await this.db.select().from(exportsTable).where(and(eq(exportsTable.organizationId, user.organizationId), eq(exportsTable.idempotencyKey, fingerprint), eq(exportsTable.status, 'QUEUED'))).limit(1);
    if (existing) return { status: existing.status, exportId: existing.id };
    const [record] = await this.db.insert(exportsTable).values({ organizationId: user.organizationId, requestedByUserId: user.id, searchExecutionId: filters.searchExecutionId ?? null, format: dto.format, status: 'QUEUED', filters, fields, fileName: null, filePath: null, fileSize: null, rowCount: null, errorMessage: null, idempotencyKey: fingerprint, expiresAt: null }).returning();
    if (!record) throw new Error('Export could not be created');
    const job = await this.queue.enqueue({ exportId: record.id, organizationId: user.organizationId });
    await this.audit(user.organizationId, user.id, record.id, 'EXPORT_REQUESTED', { exportId: record.id, format: dto.format, filters, fields, jobId: job.id });
    return { status: 'QUEUED' as const, exportId: record.id, jobId: job.id };
  }

  async process(data: ExportJobData) {
    const [record] = await this.db.select().from(exportsTable).where(and(eq(exportsTable.id, data.exportId), eq(exportsTable.organizationId, data.organizationId))).limit(1);
    if (!record) throw new NotFoundException('Export not found');
    await this.db.update(exportsTable).set({ status: 'PROCESSING', startedAt: new Date(), updatedAt: new Date() }).where(eq(exportsTable.id, record.id));
    await this.audit(data.organizationId, null, record.id, 'EXPORT_STARTED', { exportId: record.id });
    try {
      const filters = this.toFilters(record.filters);
      const fields = this.toFields(record.fields);
      const chunks: Buffer[] = [];
      let rowCount = 0;
      const header = fields;
      if (record.format === 'csv') chunks.push(this.format.csv(header, []));
      const xlsxRows: string[][] = [];
      await this.leads.forEachExportBatch({ id: record.requestedByUserId, organizationId: data.organizationId } as AuthenticatedUser, filters, async (leads) => {
        const rows = this.format.toRows(leads, fields);
        rowCount += rows.length;
        if (record.format === 'csv') chunks.push(Buffer.from(rows.map((row) => row.map((value) => this.csvCell(value)).join(',')).join('\r\n') + (rows.length ? '\r\n' : ''), 'utf8'));
        else xlsxRows.push(...rows);
      });
      const content = record.format === 'csv' ? Buffer.concat(chunks) : this.format.xlsx(fields, xlsxRows);
      const fileName = `leadpilot-export-${record.id}.${record.format}`;
      await this.storage.save(fileName, content);
      const retentionDays = this.config.get<number>('export.retentionDays', 7);
      const expiresAt = new Date(Date.now() + retentionDays * 86400000);
      await this.db.update(exportsTable).set({ status: 'COMPLETED', fileName, filePath: fileName, fileSize: content.length, rowCount, completedAt: new Date(), expiresAt, updatedAt: new Date() }).where(eq(exportsTable.id, record.id));
      await this.audit(data.organizationId, null, record.id, 'EXPORT_COMPLETED', { exportId: record.id, rowCount, fileSize: content.length });
      return { exportId: record.id, status: 'COMPLETED', rowCount };
    } catch (error) {
      await this.db.update(exportsTable).set({ status: 'FAILED', errorMessage: error instanceof Error ? error.message : 'Export failed', updatedAt: new Date() }).where(eq(exportsTable.id, record.id));
      await this.audit(data.organizationId, null, record.id, 'EXPORT_FAILED', { exportId: record.id });
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
    return { data: rows.map((row) => this.publicRecord(row)), pagination: { page: filters.page, limit: filters.limit, total: Number(total), totalPages: Math.ceil(Number(total) / filters.limit) } };
  }

  async download(id: string, organizationId: string) {
    const record = await this.expireIfNeeded(await this.find(id, organizationId));
    if (record.status !== 'COMPLETED' || !record.fileName) throw new NotFoundException('Export file is not available');
    const content = await this.storage.get(record.fileName);
    await this.audit(organizationId, null, record.id, 'EXPORT_DOWNLOADED', { exportId: record.id });
    return { record, content };
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
      await this.audit(record.organizationId, null, record.id, 'EXPORT_EXPIRED', { exportId: record.id });
      return updated ?? { ...record, status: 'EXPIRED' as ExportStatus };
    }
    return record;
  }

  private toFilters(value: unknown) { return Object.assign(new ListLeadsDto(), typeof value === 'object' && value !== null ? value : {}); }
  private toFields(value: unknown): ExportField[] { return Array.isArray(value) ? value.filter((field): field is ExportField => typeof field === 'string') : DEFAULT_EXPORT_FIELDS; }
  private csvCell(value: string) { return /^(=|\+|-|@)/.test(value) ? `'${value}` : value.includes(',') || value.includes('"') || value.includes('\r') || value.includes('\n') ? `"${value.replace(/"/g, '""')}"` : value; }
  private publicRecord(record: typeof exportsTable.$inferSelect) { return { id: record.id, format: record.format, status: record.status, rowCount: record.rowCount, fileSize: record.fileSize, fileName: record.fileName, createdAt: record.createdAt, completedAt: record.completedAt, expiresAt: record.expiresAt, errorMessage: record.errorMessage }; }
  private audit(organizationId: string, userId: string | null, entityId: string, action: string, metadata: unknown) { return this.db.insert(auditLogs).values({ organizationId, userId, entityId, action, entityType: 'export', metadata }); }
}
