import { Inject, Injectable } from '@nestjs/common';
import { and, count, eq, gte, lte, sum } from 'drizzle-orm';
import { ConfigService } from '@nestjs/config';
import { DRIZZLE } from '../database/database.constants';
import type { Database } from '../database/database.types';
import { auditLogs, organizationLimits, usageEvents } from '../database/schema/schema';
import { RedisService } from '../redis/redis.service';
import { UsageLimitExceededException } from './usage.errors';
import type { ListUsageEventsDto } from './dto/list-usage-events.dto';
import type { AuthenticatedUser } from '../auth/auth.types';
import type { UsageLimits, UsageOperation, UsageRecordInput } from './types/usage.types';

@Injectable()
export class UsageService {
  constructor(@Inject(DRIZZLE) private readonly db: Database, private readonly redis: RedisService, private readonly config: ConfigService) {}

  async getLimits(organizationId: string): Promise<UsageLimits> {
    try {
      const [stored] = await this.db.select().from(organizationLimits).where(and(eq(organizationLimits.organizationId, organizationId), eq(organizationLimits.enabled, true))).limit(1);
      if (stored) return stored;
    } catch {
      // Use configured defaults during a rolling migration before organization_limits exists.
    }
    return this.config.get<UsageLimits>('usage')!;
  }

  async checkRequestRate(organizationId: string, userId: string | undefined, operation: UsageOperation) {
    const limits = await this.getLimits(organizationId);
    const identity = userId ?? 'anonymous';
    const windows: Array<[string, number, number]> = [
      ['minute', limits.requestsPerMinute, 60],
      ['hour', limits.requestsPerHour, 3600],
      ['day', limits.requestsPerDay, 86400],
    ];
    if (operation === 'AI_CLASSIFICATION') windows.push(['ai-minute', limits.aiRequestsPerMinute, 60], ['ai-day', limits.aiRequestsPerDay, 86400]);
    for (const [window, limit, seconds] of windows) {
      const result = await this.redis.consumeFixedWindow(`usage:rate:${organizationId}:${identity}:${operation}:${window}`, limit, seconds);
      if (!result.allowed) {
        await this.audit(organizationId, userId ?? null, 'RATE_LIMIT_REACHED', { operation, window });
        throw new UsageLimitExceededException(`${operation}_${window}`, 0, result.resetAt);
      }
    }
  }

  async assertDailyQuota(organizationId: string, operation: UsageOperation, requestedUnits = 1) {
    const limits = await this.getLimits(organizationId);
    const limit = operation === 'SEARCH' ? limits.dailySearchLimit : operation === 'EXPORT' ? limits.dailyExportLimit : operation === 'AI_CLASSIFICATION' ? limits.dailyAiLimit : null;
    if (limit === null) return;
    const used = await this.sumSince(organizationId, operation, this.startOfDay());
    if (used + requestedUnits > limit) {
      await this.audit(organizationId, null, `${operation}_LIMIT_REACHED`, { operation, limit, used, requestedUnits });
      throw new UsageLimitExceededException(`${operation}_DAILY`, Math.max(0, limit - used), this.nextDay());
    }
  }

  async assertMaxLeads(organizationId: string, requested: number) {
    const limits = await this.getLimits(organizationId);
    if (requested > limits.maxLeadsPerSearch) throw new UsageLimitExceededException('MAX_LEADS_PER_SEARCH', Math.max(0, limits.maxLeadsPerSearch - requested), new Date(Date.now() + 86400000));
  }

  async assertMaxExportRows(organizationId: string, requested: number) {
    const limits = await this.getLimits(organizationId);
    if (requested > limits.maxExportRows) throw new UsageLimitExceededException('MAX_EXPORT_ROWS', Math.max(0, limits.maxExportRows - requested), new Date(Date.now() + 86400000));
  }

  recordUsage(input: UsageRecordInput) {
    const units = input.units ?? 1;
    const costStatus = input.costStatus ?? 'UNKNOWN';
    const estimatedCost = input.estimatedCost ?? null;
    if (!Number.isInteger(units) || units <= 0) throw new Error('Usage units must be a positive integer');
    if ((costStatus === 'UNKNOWN' && estimatedCost !== null) || (costStatus !== 'UNKNOWN' && estimatedCost === null)) {
      throw new Error('Usage cost and cost status must agree');
    }
    return this.db.insert(usageEvents).values({ organizationId: input.organizationId, userId: input.userId ?? null, eventType: input.operation, operation: input.operation, provider: input.provider ?? null, resourceType: input.resourceType ?? null, resourceId: input.resourceId ?? null, quantity: units, status: input.status ?? 'COMPLETED', estimatedCost: estimatedCost?.toFixed(6) ?? null, costStatus, requestId: input.requestId ?? null, metadata: input.metadata ?? null }).returning();
  }

  async getUsage(organizationId: string, operation: UsageOperation, since: Date) {
    return this.sumSince(organizationId, operation, since);
  }

  async summary(user: AuthenticatedUser) {
    const limits = await this.getLimits(user.organizationId);
    const start = this.startOfDay();
    const rows = await this.db.select({ operation: usageEvents.operation, units: sum(usageEvents.quantity) }).from(usageEvents).where(and(eq(usageEvents.organizationId, user.organizationId), gte(usageEvents.createdAt, start))).groupBy(usageEvents.operation);
    const used = Object.fromEntries(rows.map((row) => [row.operation, Number(row.units ?? 0)]));
    return { date: start.toISOString(), limits, used, remaining: { SEARCH: Math.max(0, limits.dailySearchLimit - (used.SEARCH ?? 0)), EXPORT: Math.max(0, limits.dailyExportLimit - (used.EXPORT ?? 0)), AI_CLASSIFICATION: Math.max(0, limits.dailyAiLimit - (used.AI_CLASSIFICATION ?? 0)) }, resetAt: this.nextDay().toISOString() };
  }

  async history(user: AuthenticatedUser, filters: ListUsageEventsDto) {
    const conditions = [eq(usageEvents.organizationId, user.organizationId)];
    if (filters.provider) conditions.push(eq(usageEvents.provider, filters.provider));
    if (filters.operation) conditions.push(eq(usageEvents.operation, filters.operation));
    if (filters.status) conditions.push(eq(usageEvents.status, filters.status));
    if (filters.createdFrom) conditions.push(gte(usageEvents.createdAt, new Date(filters.createdFrom)));
    if (filters.createdTo) conditions.push(lte(usageEvents.createdAt, new Date(filters.createdTo)));
    const where = and(...conditions);
    const [{ total }] = await this.db.select({ total: count() }).from(usageEvents).where(where);
    const data = await this.db.select().from(usageEvents).where(where).orderBy(usageEvents.createdAt).limit(filters.limit).offset((filters.page - 1) * filters.limit);
    return { data, pagination: { page: filters.page, limit: filters.limit, total: Number(total), totalPages: Math.ceil(Number(total) / filters.limit) } };
  }

  private async sumSince(organizationId: string, operation: string, since: Date) { const [row] = await this.db.select({ units: sum(usageEvents.quantity) }).from(usageEvents).where(and(eq(usageEvents.organizationId, organizationId), eq(usageEvents.operation, operation), gte(usageEvents.createdAt, since))); return Number(row?.units ?? 0); }
  private startOfDay() { const date = new Date(); date.setUTCHours(0, 0, 0, 0); return date; }
  private nextDay() { const date = this.startOfDay(); date.setUTCDate(date.getUTCDate() + 1); return date; }
  private audit(organizationId: string, userId: string | null, action: string, metadata: unknown) { return this.db.insert(auditLogs).values({ organizationId, userId, action, entityType: 'usage', metadata }); }
}
