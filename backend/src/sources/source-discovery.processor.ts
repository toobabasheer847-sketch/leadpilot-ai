import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { Job, UnrecoverableError } from 'bullmq';
import { DRIZZLE } from '../database/database.constants';
import type { Database } from '../database/database.types';
import { auditLogs, pipelineJobs, searchExecutions } from '../database/schema/schema';
import { SearchPlan } from '../search/types/search-plan.types';
import { isTerminalProviderError, SourceProviderError } from './providers/source-provider.error';
import { SourceDiscoveryJobData } from './source-discovery.queue';
import { SourceDiscoveryService } from './services/source-discovery.service';
import { StructuredLoggerService } from '../common/observability/structured-logger.service';

@Processor('source-discovery-queue')
export class SourceDiscoveryProcessor extends WorkerHost {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly discovery: SourceDiscoveryService,
    private readonly logger: StructuredLoggerService,
  ) {
    super();
  }

  async process(job: Job<SourceDiscoveryJobData>): Promise<{ candidates: number }> {
    const startedAt = new Date();
    const { searchExecutionId, organizationId } = job.data;
    await this.setRunning(searchExecutionId, job.id?.toString(), startedAt);

    try {
      const execution = await this.db.select({ plan: searchExecutions.structuredPlan }).from(searchExecutions)
        .where(and(eq(searchExecutions.id, searchExecutionId), eq(searchExecutions.organizationId, organizationId)))
        .limit(1);
      const plan = execution[0]?.plan as SearchPlan | null;
      if (!plan) throw new Error('Search execution plan is unavailable.');

      const result = await this.discovery.discover(searchExecutionId, organizationId, plan, { correlationId: job.data.correlationId });
      await this.db.update(searchExecutions).set({
        status: 'COMPLETED',
        completedAt: new Date(),
        totalCandidates: result.candidates,
        totalLeads: 0,
        errorMessage: null,
        updatedAt: new Date(),
      }).where(eq(searchExecutions.id, searchExecutionId));
      await this.updateJob(searchExecutionId, 'COMPLETED', new Date());
      return result;
    } catch (error) {
      const safeMessage = error instanceof SourceProviderError || error instanceof Error
        ? error.message
        : 'Source discovery failed.';
      this.logger.warn('job.source_discovery.failed', { jobId: job.id, errorType: error instanceof Error ? error.name : 'unknown', errorCode: error instanceof SourceProviderError ? error.code : undefined });
      await this.db.update(searchExecutions).set({
        status: 'FAILED',
        completedAt: new Date(),
        errorMessage: safeMessage,
        updatedAt: new Date(),
      }).where(eq(searchExecutions.id, searchExecutionId));
      await this.updateJob(searchExecutionId, 'FAILED', new Date(), safeMessage);
      await this.db.insert(auditLogs).values({
        organizationId,
        entityId: searchExecutionId,
        action: 'SOURCE_SEARCH_FAILED',
        entityType: 'search_execution',
        metadata: { error: safeMessage },
      });
      if (isTerminalProviderError(error)) {
        throw new UnrecoverableError(safeMessage);
      }
      throw error;
    }
  }

  private async setRunning(executionId: string, bullJobId: string | undefined, startedAt: Date) {
    await this.db.update(searchExecutions).set({ status: 'RUNNING', startedAt, updatedAt: new Date() }).where(eq(searchExecutions.id, executionId));
    await this.updateJob(executionId, 'RUNNING', undefined, undefined, bullJobId);
  }

  private async updateJob(executionId: string, status: string, completedAt?: Date, errorMessage?: string, bullJobId?: string) {
    await this.db.update(pipelineJobs).set({ status, ...(completedAt ? { completedAt } : {}), ...(errorMessage ? { errorMessage } : {}), ...(bullJobId ? { bullJobId } : {}), updatedAt: new Date() }).where(and(
      eq(pipelineJobs.searchExecutionId, executionId),
      eq(pipelineJobs.jobType, 'SEARCH_DISCOVERY'),
    ));
  }
}
