import { ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { MAX_STAGE_WAITS, type PipelineErrorCode, type PipelineStage, type PipelineStatus } from './pipeline.constants';
import { classifyPipelineError, initialProgress, parseProgress, progressKey, shouldRetryPipelineFailure } from './pipeline.progress';
import { PipelineQueue } from './pipeline.queue';
import { PipelineRepository, type PipelineExecutionRow } from './pipeline.repository';
import { PipelineStageRunner } from './pipeline.runner';
import type { LeadPipelineJobData, PipelineView, StageTick } from './pipeline.types';
import { StructuredLoggerService } from '../common/observability/structured-logger.service';
import { SearchService } from '../search/search.service';
import type { AuthenticatedUser } from '../auth/auth.types';

@Injectable()
export class PipelineService {
  constructor(
    private readonly repository: PipelineRepository,
    private readonly searches: SearchService,
    private readonly queue: PipelineQueue,
    private readonly runner: PipelineStageRunner,
    @Inject(StructuredLoggerService) private readonly logger: StructuredLoggerService,
  ) {}

  async start(user: AuthenticatedUser, searchId: string): Promise<PipelineView> {
    await this.searches.findOne(user, searchId);
    const active = await this.repository.findActive(user.organizationId, searchId);
    if (active) return this.view(active);

    const execution = await this.searches.createExecution(user, searchId);
    try {
      const created = await this.repository.insert({
        organizationId: user.organizationId,
        searchId,
        searchExecutionId: execution.id,
        status: 'QUEUED',
        currentStage: 'SOURCE_DISCOVERY',
        stageProgress: initialProgress(),
      });
      await this.enqueue(created, user.id, 0);
      await this.repository.audit(user.organizationId, user.id, 'PIPELINE_STARTED', created.id, { searchId, searchExecutionId: execution.id });
      this.logger.info('pipeline.started', { pipelineExecutionId: created.id, searchExecutionId: execution.id, organizationId: user.organizationId, stage: created.currentStage });
      return this.view(created);
    } catch (error) {
      if (isUniqueViolation(error)) {
        const existing = await this.repository.findActive(user.organizationId, searchId);
        if (existing) return this.view(existing);
      }
      throw error;
    }
  }

  async getForSearch(user: AuthenticatedUser, searchId: string): Promise<PipelineView> {
    await this.searches.findOne(user, searchId);
    const row = await this.repository.findLatest(user.organizationId, searchId);
    if (!row) throw new NotFoundException('Pipeline execution not found');
    return this.view(row);
  }

  async cancel(user: AuthenticatedUser, pipelineExecutionId: string): Promise<PipelineView> {
    const row = await this.repository.findById(user.organizationId, pipelineExecutionId);
    if (!row) throw new NotFoundException('Pipeline execution not found');
    if (row.status === 'COMPLETED' || row.status === 'FAILED' || row.status === 'CANCELLED') {
      throw new ConflictException('Pipeline execution cannot be cancelled');
    }
    const progress = parseProgress(row.stageProgress);
    const updated = await this.repository.update(user.organizationId, row.id, { status: 'CANCELLED' });
    await this.queue.removePending(row.id, row.currentStage, progress.waits);
    await this.repository.audit(user.organizationId, user.id, 'PIPELINE_CANCELLED', row.id, { stage: row.currentStage });
    this.logger.info('pipeline.cancelled', { pipelineExecutionId: row.id, searchExecutionId: row.searchExecutionId, organizationId: user.organizationId, stage: row.currentStage });
    return this.view(updated ?? { ...row, status: 'CANCELLED' });
  }

  async runTick(data: LeadPipelineJobData, attemptsMade: number, attempts: number) {
    const row = await this.repository.findById(data.organizationId, data.pipelineExecutionId);
    if (!row || row.status === 'CANCELLED' || row.status === 'COMPLETED' || row.status === 'FAILED') return;
    const running = row.status === 'QUEUED'
      ? await this.repository.update(data.organizationId, row.id, { status: 'RUNNING', startedAt: row.startedAt ?? new Date() }) ?? row
      : row;
    const progress = parseProgress(running.stageProgress);
    try {
      const tick = await this.runner.tick(running, progress);
      await this.apply(data, running, tick);
    } catch (error) {
      const classified = classifyPipelineError(error);
      if (shouldRetryPipelineFailure(classified.retryable, attemptsMade, attempts)) throw error;
      await this.fail(data, running, classified.code, classified.message);
    }
  }

  private async apply(data: LeadPipelineJobData, row: PipelineExecutionRow, tick: StageTick) {
    const current = await this.repository.findById(data.organizationId, row.id);
    if (!current || current.status === 'CANCELLED' || current.status === 'COMPLETED' || current.status === 'FAILED') return;
    if (tick.type === 'wait') {
      const waits = tick.progress.waits + 1;
      if (waits > MAX_STAGE_WAITS) {
        await this.fail(data, row, 'TRANSIENT_PROVIDER_ERROR', 'The pipeline stage did not finish before the wait limit.');
        return;
      }
      const progress = { ...tick.progress, waits };
      await this.repository.update(data.organizationId, row.id, { status: 'RUNNING', stageProgress: progress, currentStage: row.currentStage });
      await this.enqueue({ ...row, stageProgress: progress }, data.userId, waits);
      return;
    }
    if (tick.type === 'fail') {
      await this.fail(data, { ...row, stageProgress: tick.progress, currentStage: row.currentStage }, tick.errorCode, tick.errorMessage);
      return;
    }
    if (tick.type === 'complete') {
      const updated = await this.repository.update(data.organizationId, row.id, {
        status: 'COMPLETED',
        currentStage: 'COMPLETED',
        stageProgress: tick.progress,
        completedAt: new Date(),
        errorCode: null,
        errorMessage: null,
      });
      await this.repository.audit(data.organizationId, data.userId, 'PIPELINE_COMPLETED', row.id, { searchExecutionId: row.searchExecutionId });
      this.logger.info('pipeline.completed', { pipelineExecutionId: row.id, searchExecutionId: row.searchExecutionId, organizationId: data.organizationId, stage: 'COMPLETED' });
      return updated;
    }
    await this.repository.update(data.organizationId, row.id, {
      status: 'RUNNING',
      currentStage: tick.currentStage,
      stageProgress: tick.progress,
    });
    await this.enqueue({ ...row, currentStage: tick.currentStage, stageProgress: tick.progress }, data.userId, 0);
    this.logger.info('pipeline.stage_advanced', { pipelineExecutionId: row.id, searchExecutionId: row.searchExecutionId, organizationId: data.organizationId, stage: tick.currentStage });
  }

  private async fail(data: LeadPipelineJobData, row: PipelineExecutionRow, errorCode: PipelineErrorCode, errorMessage: string) {
    const progress = parseProgress(row.stageProgress);
    const key = progressKey(row.currentStage);
    if (key) progress.stages[key] = 'FAILED';
    await this.repository.update(data.organizationId, row.id, {
      status: 'FAILED',
      stageProgress: progress,
      failedAt: new Date(),
      errorCode,
      errorMessage,
    });
    await this.repository.audit(data.organizationId, data.userId, 'PIPELINE_FAILED', row.id, { stage: row.currentStage, errorCode });
    this.logger.warn('pipeline.failed', { pipelineExecutionId: row.id, searchExecutionId: row.searchExecutionId, organizationId: data.organizationId, stage: row.currentStage, errorCode });
  }

  private async enqueue(row: PipelineExecutionRow, userId: string, wait: number) {
    if (!row.searchExecutionId) throw new ServiceUnavailableException('Pipeline execution is missing a search execution.');
    const data: LeadPipelineJobData = {
      pipelineExecutionId: row.id,
      organizationId: row.organizationId,
      userId,
      searchId: row.searchId,
      searchExecutionId: row.searchExecutionId,
    };
    try {
      await this.queue.enqueue(data, row.currentStage, wait);
    } catch (error) {
      if (wait === 0 && row.status === 'QUEUED') {
        await this.repository.update(row.organizationId, row.id, {
          status: 'FAILED',
          failedAt: new Date(),
          errorCode: 'TRANSIENT_PROVIDER_ERROR',
          errorMessage: 'Pipeline job could not be queued.',
        });
      }
      this.logger.warn('pipeline.queue_failed', { pipelineExecutionId: row.id, organizationId: row.organizationId, stage: row.currentStage });
      if (error instanceof Error && /already exists|job is already/i.test(error.message)) return;
      throw new ServiceUnavailableException('Pipeline is temporarily unavailable.');
    }
  }

  view(row: PipelineExecutionRow): PipelineView {
    const progress = parseProgress(row.stageProgress);
    return {
      pipelineExecutionId: row.id,
      searchId: row.searchId,
      searchExecutionId: row.searchExecutionId,
      status: row.status as PipelineStatus,
      currentStage: row.currentStage as PipelineStage,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      failedAt: row.failedAt,
      stages: progress.stages,
      error: row.errorCode && row.errorMessage ? { code: row.errorCode as PipelineErrorCode, message: row.errorMessage } : null,
    };
  }
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if ('code' in error && error.code === '23505') return true;
  return 'cause' in error && isUniqueViolation(error.cause);
}
