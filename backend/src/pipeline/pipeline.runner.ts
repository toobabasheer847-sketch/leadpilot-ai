import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { SearchPlan } from '../search/types/search-plan.types';
import { employeeSizeRequested, contactDiscoveryRequested, decisionMakerRolesForPlan } from '../search/search-plan.limits';
import type { ClassificationCriteria } from '../ai/classification/types/classification.types';
import { clampConcurrency, mapWithConcurrency } from '../common/concurrency';
import { MetricsService } from '../common/observability/metrics.service';
import { EnrichmentService } from '../enrichment/enrichment.service';
import { ContactsService } from '../contacts/contacts.service';
import { ClassificationService } from '../ai/classification/classification.service';
import { VerificationService } from '../verification/verification.service';
import { DeduplicationService } from '../deduplication/deduplication.service';
import { ScoringService } from '../scoring/scoring.service';
import { QualificationService } from '../qualification/qualification.service';
import { ResearchService } from '../research/research.service';
import { ContactQualityService } from '../contacts/quality/contact-quality.service';
import { EmployeeSizeQueue } from '../enrichment/employee-size/employee-size.queue';
import { TRACKED_QUEUES, type PipelineErrorCode, type StageProgressKey, type StageState, type WorkStage } from './pipeline.constants';
import {
  AFTER_POST_ENRICHMENT,
  AFTER_POST_EVIDENCE,
  POST_ENRICHMENT_PARALLEL,
  POST_EVIDENCE_PARALLEL,
  type PostEnrichmentKey,
  type PostEvidenceKey,
} from './pipeline.dependencies';
import { PipelineJobInspector } from './pipeline.job-inspector';
import {
  accumulateWait,
  classifyPipelineError,
  emptyStageMetrics,
  ENRICHMENT_EMPTY_MESSAGE,
  isSettledStageState,
  markStageCompleted,
  markStageStarted,
  nextWorkStage,
  progressKey,
  WEBSITE_PARTIAL_MESSAGE,
  withStageState,
} from './pipeline.progress';
import { PipelineRepository, type PipelineExecutionRow } from './pipeline.repository';
import type { PipelineProgressState, StageTick } from './pipeline.types';

type TrackedKey = keyof typeof TRACKED_QUEUES;

const KEY_TO_STAGE: Record<TrackedKey, WorkStage> = {
  websiteDiscovery: 'WEBSITE_DISCOVERY',
  enrichment: 'ENRICHMENT',
  deepResearch: 'DEEP_RESEARCH',
  employeeSize: 'EMPLOYEE_SIZE',
  decisionMakerDiscovery: 'DECISION_MAKER_DISCOVERY',
  contactQuality: 'CONTACT_QUALITY',
  classification: 'CLASSIFICATION',
  verification: 'VERIFICATION',
  deduplication: 'DEDUPLICATION',
  scoring: 'SCORING',
  qualification: 'QUALIFICATION',
};

type SettleResult = Awaited<ReturnType<PipelineJobInspector['settle']>>;

@Injectable()
export class PipelineStageRunner {
  private readonly dispatchConcurrency: number;

  constructor(
    private readonly repository: PipelineRepository,
    private readonly enrichment: EnrichmentService,
    private readonly contacts: ContactsService,
    private readonly classification: ClassificationService,
    private readonly verification: VerificationService,
    private readonly deduplication: DeduplicationService,
    private readonly scoring: ScoringService,
    private readonly qualification: QualificationService,
    private readonly research: ResearchService,
    private readonly contactQuality: ContactQualityService,
    private readonly employeeSize: EmployeeSizeQueue,
    private readonly jobs: PipelineJobInspector,
    private readonly metrics: MetricsService,
    config: ConfigService,
  ) {
    this.dispatchConcurrency = clampConcurrency(
      config.get<number>('enrichment.dispatchConcurrency') ?? config.get<number>('enrichment.concurrency'),
      8,
      32,
    );
  }

  tick(row: PipelineExecutionRow, progress: PipelineProgressState): Promise<StageTick> {
    const withLimit = progress.metrics?.concurrencyLimit == null
      ? { ...progress, metrics: { ...(progress.metrics ?? emptyStageMetrics()), concurrencyLimit: this.dispatchConcurrency } }
      : progress;
    switch (row.currentStage) {
      case 'SEARCH':
        return this.tickSearch(row, withLimit);
      case 'SOURCE_DISCOVERY':
      case 'COMPANY_PERSISTENCE':
        return this.tickDiscovery(row, withLimit, row.currentStage);
      case 'WEBSITE_DISCOVERY':
        return this.tickTracked(row, withLimit, 'websiteDiscovery');
      case 'ENRICHMENT':
        return this.finishTracked(withLimit, 'enrichment', withLimit.jobs.websiteDiscovery ?? []);
      case 'DEEP_RESEARCH':
        return this.tickPostEnrichmentParallel(row, withLimit);
      case 'EMPLOYEE_SIZE':
        return this.tickSettledOrTracked(row, withLimit, 'employeeSize');
      case 'DECISION_MAKER_DISCOVERY':
        return this.tickSettledOrTracked(row, withLimit, 'decisionMakerDiscovery');
      case 'CONTACT_QUALITY':
        return this.tickTracked(row, withLimit, 'contactQuality');
      case 'EVIDENCE':
        return this.tickEvidence(row, withLimit);
      case 'CLASSIFICATION':
        return this.tickPostEvidenceParallel(row, withLimit);
      case 'VERIFICATION':
        return this.tickSettledOrTracked(row, withLimit, 'verification');
      case 'DEDUPLICATION':
        return this.tickTracked(row, withLimit, 'deduplication');
      case 'SCORING':
        return this.tickTracked(row, withLimit, 'scoring');
      case 'QUALIFICATION':
        return this.tickQualification(row, withLimit);
      default:
        return Promise.resolve(this.fail(withLimit, 'SOURCE_DISCOVERY', 'INTERNAL_ERROR', 'Pipeline stage failed.'));
    }
  }

  private async tickSearch(row: PipelineExecutionRow, progress: PipelineProgressState): Promise<StageTick> {
    if (!row.searchExecutionId) return this.fail(progress, 'SEARCH', 'NOT_FOUND', 'Search execution not found');
    const execution = await this.repository.getSearchExecution(row.organizationId, row.searchExecutionId);
    if (!execution) return this.fail(progress, 'SEARCH', 'NOT_FOUND', 'Search execution not found');
    return this.move(progress, 'search', 'SOURCE_DISCOVERY');
  }

  private async tickEvidence(row: PipelineExecutionRow, progress: PipelineProgressState): Promise<StageTick> {
    if (!row.searchExecutionId) return this.fail(progress, 'EVIDENCE', 'NOT_FOUND', 'Search execution not found');
    // Evidence barrier: prior writers (enrichment, deep research, DM, contact quality) must already be settled
    // by the stage graph before this tick runs.
    const companyIds = await this.repository.listCompanyIds(row.organizationId, row.searchExecutionId);
    await this.repository.countEvidence(row.organizationId, companyIds);
    return this.move(markStageCompleted(markStageStarted(progress, 'evidence', companyIds.length), 'evidence'), 'evidence', nextWorkStage('EVIDENCE'));
  }

  private async tickDiscovery(row: PipelineExecutionRow, progress: PipelineProgressState, stage: 'SOURCE_DISCOVERY' | 'COMPANY_PERSISTENCE'): Promise<StageTick> {
    if (!row.searchExecutionId) return this.fail(progress, stage, 'NOT_FOUND', 'Search execution not found');
    const execution = await this.repository.getSearchExecution(row.organizationId, row.searchExecutionId);
    if (!execution) return this.fail(progress, stage, 'NOT_FOUND', 'Search execution not found');
    if (execution.status === 'FAILED') {
      const classified = classifyPipelineError(new Error(execution.errorMessage || 'Source discovery failed.'));
      return this.fail(progress, 'SOURCE_DISCOVERY', classified.code, classified.message);
    }
    if (execution.status !== 'COMPLETED') return { type: 'wait', progress };
    if (stage === 'SOURCE_DISCOVERY') {
      return this.move(progress, 'sourceDiscovery', 'COMPANY_PERSISTENCE');
    }
    return this.move(progress, 'companyPersistence', 'WEBSITE_DISCOVERY');
  }

  private async tickTracked(row: PipelineExecutionRow, progress: PipelineProgressState, key: TrackedKey): Promise<StageTick> {
    if (!progress.jobs[key]) {
      const jobIds = await this.dispatch(row, key);
      let dispatched = { ...progress, jobs: { ...progress.jobs, [key]: jobIds }, stages: { ...progress.stages, [key]: (jobIds.length === 0 ? 'SKIPPED' : 'RUNNING') as StageState } };
      dispatched = markStageStarted(dispatched, key, jobIds.length);
      this.observeDispatch(key, jobIds.length);
      if (jobIds.length === 0) {
        return this.advance(markStageCompleted(dispatched, key), key, 'SKIPPED');
      }
      return { type: 'wait', progress: dispatched };
    }
    return this.finishTracked(progress, key, progress.jobs[key] ?? []);
  }

  /**
   * After enrichment: deep research, employee-size, and decision-maker discovery are independent.
   * Dispatch together so unrelated stages do not wait serially for each other.
   */
  private async tickPostEnrichmentParallel(row: PipelineExecutionRow, progress: PipelineProgressState): Promise<StageTick> {
    let next = progress;
    if (!next.jobs.deepResearch) {
      const [deepIds, sizeIds, dmIds] = await Promise.all([
        this.dispatch(row, 'deepResearch'),
        this.dispatch(row, 'employeeSize'),
        this.dispatch(row, 'decisionMakerDiscovery'),
      ]);
      next = {
        ...next,
        jobs: { ...next.jobs, deepResearch: deepIds, employeeSize: sizeIds, decisionMakerDiscovery: dmIds },
        stages: {
          ...next.stages,
          deepResearch: deepIds.length > 0 ? 'RUNNING' : 'SKIPPED',
          employeeSize: sizeIds.length > 0 ? 'RUNNING' : 'SKIPPED',
          decisionMakerDiscovery: dmIds.length > 0 ? 'RUNNING' : 'SKIPPED',
        },
      };
      for (const key of POST_ENRICHMENT_PARALLEL) {
        const ids = next.jobs[key] ?? [];
        next = markStageStarted(next, key, ids.length);
        this.observeDispatch(key, ids.length);
      }
      if (deepIds.length === 0 && sizeIds.length === 0 && dmIds.length === 0) {
        let done = next;
        for (const key of POST_ENRICHMENT_PARALLEL) done = markStageCompleted(done, key);
        return this.advanceTo(done, AFTER_POST_ENRICHMENT);
      }
      return { type: 'wait', progress: next };
    }

    return this.settleParallelGroup(next, POST_ENRICHMENT_PARALLEL, 'DEEP_RESEARCH', AFTER_POST_ENRICHMENT);
  }

  /**
   * After evidence barrier: classification and verification do not consume each other's outputs.
   */
  private async tickPostEvidenceParallel(row: PipelineExecutionRow, progress: PipelineProgressState): Promise<StageTick> {
    let next = progress;
    if (!next.jobs.classification) {
      const [classificationIds, verificationIds] = await Promise.all([
        this.dispatch(row, 'classification'),
        this.dispatch(row, 'verification'),
      ]);
      next = {
        ...next,
        jobs: { ...next.jobs, classification: classificationIds, verification: verificationIds },
        stages: {
          ...next.stages,
          classification: classificationIds.length > 0 ? 'RUNNING' : 'SKIPPED',
          verification: verificationIds.length > 0 ? 'RUNNING' : 'SKIPPED',
        },
      };
      for (const key of POST_EVIDENCE_PARALLEL) {
        const ids = next.jobs[key] ?? [];
        next = markStageStarted(next, key, ids.length);
        this.observeDispatch(key, ids.length);
      }
      if (classificationIds.length === 0 && verificationIds.length === 0) {
        let done = next;
        for (const key of POST_EVIDENCE_PARALLEL) done = markStageCompleted(done, key);
        return this.advanceTo(done, AFTER_POST_EVIDENCE);
      }
      return { type: 'wait', progress: next };
    }

    return this.settleParallelGroup(next, POST_EVIDENCE_PARALLEL, 'CLASSIFICATION', AFTER_POST_EVIDENCE);
  }

  private async settleParallelGroup(
    progress: PipelineProgressState,
    keys: readonly (PostEnrichmentKey | PostEvidenceKey)[],
    failStage: WorkStage,
    nextStage: WorkStage,
  ): Promise<StageTick> {
    const settlements: Array<{ key: StageProgressKey; ids: string[]; settle: SettleResult }> = [];
    for (const key of keys) {
      const ids = progress.jobs[key] ?? [];
      if (ids.length === 0) {
        settlements.push({ key, ids, settle: { state: 'COMPLETED' } });
        continue;
      }
      const settle = await this.jobs.settle(TRACKED_QUEUES[key as TrackedKey], ids);
      settlements.push({ key, ids, settle });
    }

    if (settlements.some((item) => item.ids.length > 0 && item.settle.state === 'PENDING')) {
      let waiting = progress;
      for (const item of settlements) {
        if (item.ids.length === 0) {
          waiting = withStageState(waiting, item.key, 'SKIPPED');
          continue;
        }
        if (item.settle.state === 'PENDING') {
          waiting = accumulateWait(withStageState(waiting, item.key, 'RUNNING'), item.key, 2000);
        } else if (item.settle.state === 'FAILED' || item.settle.state === 'PARTIAL') {
          waiting = withStageState(waiting, item.key, 'PARTIAL');
        } else {
          waiting = withStageState(waiting, item.key, 'COMPLETED');
        }
      }
      return { type: 'wait', progress: waiting };
    }

    const active = settlements.filter((item) => item.ids.length > 0);
    if (active.length > 0 && active.every((item) => item.settle.state === 'FAILED')) {
      const failed = active[0];
      const message = failed && failed.settle.state === 'FAILED' ? failed.settle.message : 'Pipeline stage failed.';
      const classified = classifyPipelineError(new Error(message));
      return this.fail(progress, failStage, classified.code, classified.message);
    }

    let updated = progress;
    for (const item of settlements) {
      if (item.ids.length === 0) {
        updated = withStageState(updated, item.key, 'SKIPPED');
        updated = markStageCompleted(updated, item.key);
        continue;
      }
      if (item.settle.state === 'FAILED' || item.settle.state === 'PARTIAL') {
        updated = { ...updated, failures: [...updated.failures, { stage: KEY_TO_STAGE[item.key as TrackedKey], message: item.settle.message }] };
        updated = withStageState(updated, item.key, 'PARTIAL');
        updated = markStageCompleted(updated, item.key, item.ids.length);
        this.metrics.increment('pipeline_stage_jobs_failed_total', { stage: item.key });
      } else {
        updated = withStageState(updated, item.key, 'COMPLETED');
        updated = markStageCompleted(updated, item.key);
      }
      const timing = updated.metrics?.stages[item.key];
      if (timing?.durationMs != null) {
        this.metrics.observe('pipeline_stage_duration_ms', timing.durationMs, { stage: item.key });
        if (timing.waitingMs != null && timing.waitingMs > 0) {
          this.metrics.observe('pipeline_stage_waiting_ms', timing.waitingMs, { stage: item.key });
        }
      }
    }

    return this.advanceTo(updated, nextStage);
  }

  private async tickSettledOrTracked(row: PipelineExecutionRow, progress: PipelineProgressState, key: TrackedKey): Promise<StageTick> {
    if (progress.jobs[key] !== undefined && isSettledStageState(progress.stages[key])) {
      const state = progress.stages[key];
      const outcome = state === 'PARTIAL' ? 'PARTIAL' : state === 'SKIPPED' ? 'SKIPPED' : 'COMPLETED';
      return this.move(progress, key, nextWorkStage(KEY_TO_STAGE[key]), outcome);
    }
    return this.tickTracked(row, progress, key);
  }

  private async finishTracked(progress: PipelineProgressState, key: TrackedKey, jobIds: string[]): Promise<StageTick> {
    const settlement = await this.jobs.settle(TRACKED_QUEUES[key], jobIds);
    if (settlement.state === 'PENDING') {
      return { type: 'wait', progress: accumulateWait(withStageState(progress, key, 'RUNNING'), key, 2000) };
    }
    if (settlement.state === 'FAILED') {
      const classified = classifyPipelineError(new Error(settlement.message));
      return this.fail(markStageCompleted(progress, key, jobIds.length), KEY_TO_STAGE[key], classified.code, classified.message);
    }
    let completed = markStageCompleted(progress, key, settlement.state === 'PARTIAL' ? 1 : 0);
    const timing = completed.metrics?.stages[key];
    if (timing?.durationMs != null) {
      this.metrics.observe('pipeline_stage_duration_ms', timing.durationMs, { stage: key });
      if (timing.waitingMs != null && timing.waitingMs > 0) {
        this.metrics.observe('pipeline_stage_waiting_ms', timing.waitingMs, { stage: key });
      }
    }
    if (settlement.state === 'PARTIAL') {
      const message = key === 'enrichment' && settlement.message === WEBSITE_PARTIAL_MESSAGE ? ENRICHMENT_EMPTY_MESSAGE : settlement.message;
      const failures = [...completed.failures, { stage: KEY_TO_STAGE[key], message }];
      this.metrics.increment('pipeline_stage_jobs_failed_total', { stage: key });
      return this.advance({ ...completed, failures }, key, 'PARTIAL');
    }
    return this.advance(completed, key);
  }

  private async tickQualification(row: PipelineExecutionRow, progress: PipelineProgressState): Promise<StageTick> {
    if (!row.searchExecutionId) return this.fail(progress, 'QUALIFICATION', 'NOT_FOUND', 'Search execution not found');
    if (!progress.jobs.qualification) {
      const result = await this.qualification.enqueueExecution(row.searchExecutionId, row.organizationId, false);
      const jobIds = result.status === 'QUEUED' && 'jobId' in result && result.jobId ? [String(result.jobId)] : [];
      const queued: PipelineProgressState = {
        ...withStageState(progress, 'qualification', jobIds.length ? 'RUNNING' : 'SKIPPED'),
        jobs: { ...progress.jobs, qualification: jobIds },
      };
      const dispatched = markStageStarted(queued, 'qualification', jobIds.length);
      this.observeDispatch('qualification', jobIds.length);
      if (jobIds.length === 0) return { type: 'complete', progress: withStageState({ ...markStageCompleted(dispatched, 'qualification'), waits: 0 }, 'qualification', 'COMPLETED') };
      return { type: 'wait', progress: dispatched };
    }
    return this.finishTracked(progress, 'qualification', progress.jobs.qualification ?? []);
  }

  private async dispatch(row: PipelineExecutionRow, key: TrackedKey): Promise<string[]> {
    if (key === 'employeeSize') {
      if (!row.searchExecutionId || !employeeSizeRequested(await this.planFor(row))) return [];
    }
    if (key === 'decisionMakerDiscovery') {
      if (!row.searchExecutionId || !contactDiscoveryRequested(await this.planFor(row))) return [];
    }
    if (key === 'websiteDiscovery') {
      if (!row.searchExecutionId) return [];
      const enqueued = await this.enrichment.enqueueCompanyEnrichment(row.searchExecutionId, row.organizationId);
      return enqueued.flatMap((item) => item.jobId ? [String(item.jobId)] : []);
    }
    if (key === 'contactQuality') return this.dispatchContactQuality(row);
    if (key === 'deduplication') return this.dispatchDeduplication(row);
    if (key === 'verification') return this.dispatchVerification(row);
    if (!row.searchExecutionId) return [];
    const companyIds = await this.repository.listCompanyIds(row.organizationId, row.searchExecutionId);
    const jobIds = await mapWithConcurrency(companyIds, this.dispatchConcurrency, async (companyId) => {
      try {
        return await this.dispatchCompany(row, key, companyId);
      } catch {
        // One company enqueue failure must not abort the remaining batch.
        return null;
      }
    }, { maxConcurrency: 32 });
    return jobIds.filter((jobId): jobId is string => Boolean(jobId));
  }

  private async planFor(row: PipelineExecutionRow): Promise<unknown> {
    if (!row.searchExecutionId) return null;
    const execution = await this.repository.getSearchExecution(row.organizationId, row.searchExecutionId);
    return execution?.structuredPlan ?? null;
  }

  private async dispatchCompany(row: PipelineExecutionRow, key: TrackedKey, companyId: string): Promise<string | null> {
    if (key === 'deepResearch') {
      return this.research.enqueueTracked(companyId, row.organizationId);
    }
    if (key === 'employeeSize') {
      const job = await this.employeeSize.enqueue({ organizationId: row.organizationId, companyId });
      return job.id ? String(job.id) : null;
    }
    if (key === 'decisionMakerDiscovery') {
      const result = await this.contacts.enqueueContactDiscovery(companyId, row.organizationId, row.searchExecutionId);
      return result.jobId ? String(result.jobId) : null;
    }
    if (key === 'contactQuality') return null;
    if (key === 'classification') {
      const execution = await this.repository.getSearchExecution(row.organizationId, row.searchExecutionId as string);
      const result = await this.classification.enqueue(companyId, row.organizationId, criteriaFromPlan(execution?.structuredPlan), row.searchExecutionId, false);
      return result.status === 'QUEUED' && result.jobId ? String(result.jobId) : null;
    }
    if (key === 'verification') {
      // Handled by dispatchVerification (company + contacts).
      return null;
    }
    if (key === 'deduplication') {
      // Handled by dispatchDeduplication (company + contacts).
      return null;
    }
    if (key === 'scoring') {
      const result = await this.scoring.enqueueCompany(companyId, row.organizationId, false, row.searchExecutionId);
      return result.status === 'QUEUED' && result.jobId ? String(result.jobId) : null;
    }
    return null;
  }

  private async dispatchDeduplication(row: PipelineExecutionRow): Promise<string[]> {
    if (!row.searchExecutionId) return [];
    const companyIds = await this.repository.listCompanyIds(row.organizationId, row.searchExecutionId);
    const batches = await mapWithConcurrency(companyIds, this.dispatchConcurrency, async (companyId) => {
      const ids: string[] = [];
      try {
        const companyResult = await this.deduplication.enqueueCompany(companyId, row.organizationId, row.searchExecutionId);
        if (companyResult.jobId) ids.push(String(companyResult.jobId));
        const contacts = await this.repository.listContactIds(row.organizationId, [companyId]);
        for (const contact of contacts) {
          const contactResult = await this.deduplication.enqueueContact(contact.id, row.organizationId, row.searchExecutionId);
          if (contactResult.jobId) ids.push(String(contactResult.jobId));
        }
      } catch {
        // Continue remaining companies.
      }
      return ids;
    }, { maxConcurrency: 32 });
    return batches.flat();
  }

  private async dispatchVerification(row: PipelineExecutionRow): Promise<string[]> {
    if (!row.searchExecutionId) return [];
    const companyIds = await this.repository.listCompanyIds(row.organizationId, row.searchExecutionId);
    const batches = await mapWithConcurrency(companyIds, this.dispatchConcurrency, async (companyId) => {
      const ids: string[] = [];
      try {
        const companyResult = await this.verification.enqueueCompany(companyId, row.organizationId, false, row.searchExecutionId);
        if (companyResult.status === 'QUEUED' && 'jobId' in companyResult && companyResult.jobId) ids.push(String(companyResult.jobId));
        const contacts = await this.repository.listContactIds(row.organizationId, [companyId]);
        for (const contact of contacts) {
          const contactResult = await this.verification.enqueueContact(contact.id, row.organizationId, false, row.searchExecutionId);
          if (contactResult.status === 'QUEUED' && 'jobId' in contactResult && contactResult.jobId) ids.push(String(contactResult.jobId));
        }
      } catch {
        // Continue remaining companies.
      }
      return ids;
    }, { maxConcurrency: 32 });
    return batches.flat();
  }

  private async dispatchContactQuality(row: PipelineExecutionRow): Promise<string[]> {
    if (!row.searchExecutionId) return [];
    const companyIds = await this.repository.listCompanyIds(row.organizationId, row.searchExecutionId);
    const contacts = await this.repository.listContactIds(row.organizationId, companyIds);
    const targetRoles = decisionMakerRolesForPlan(await this.planFor(row));
    const jobIds = await mapWithConcurrency(contacts, this.dispatchConcurrency, async (contact) => {
      try {
        const result = await this.contactQuality.enqueue(contact.companyId, contact.id, row.organizationId, {
          searchExecutionId: row.searchExecutionId,
          targetRoles,
        });
        return result.jobId ? String(result.jobId) : null;
      } catch {
        return null;
      }
    }, { maxConcurrency: 32 });
    return jobIds.filter((jobId): jobId is string => Boolean(jobId));
  }

  private move(
    progress: PipelineProgressState,
    completedKey: TrackedKey | 'sourceDiscovery' | 'companyPersistence' | 'search' | 'evidence',
    next: WorkStage | 'COMPLETED',
    outcome: 'COMPLETED' | 'PARTIAL' | 'SKIPPED' = 'COMPLETED',
  ): StageTick {
    const current = progress.stages[completedKey];
    const finalState: StageState =
      outcome === 'PARTIAL' || current === 'PARTIAL' ? 'PARTIAL'
        : outcome === 'SKIPPED' || current === 'SKIPPED' ? 'SKIPPED'
          : 'COMPLETED';
    const preserved = withStageState(progress, completedKey, finalState);
    if (next === 'COMPLETED') return { type: 'complete', progress: { ...preserved, waits: 0 } };
    return this.advanceTo(preserved, next);
  }

  private advanceTo(progress: PipelineProgressState, next: WorkStage): StageTick {
    const nextKey = progressKey(next);
    const running = nextKey ? withStageState(progress, nextKey, 'RUNNING') : progress;
    return { type: 'advance', currentStage: next, progress: { ...running, waits: 0 } };
  }

  private advance(progress: PipelineProgressState, key: TrackedKey, outcome: 'COMPLETED' | 'PARTIAL' | 'SKIPPED' = 'COMPLETED'): StageTick {
    return this.move(progress, key, nextWorkStage(KEY_TO_STAGE[key]), outcome);
  }

  private fail(progress: PipelineProgressState, stage: WorkStage, errorCode: PipelineErrorCode, errorMessage: string): StageTick {
    const key = progressKey(stage);
    return {
      type: 'fail',
      errorCode,
      errorMessage,
      progress: key ? withStageState(progress, key, 'FAILED') : progress,
    };
  }

  private observeDispatch(key: string, jobCount: number) {
    this.metrics.increment('pipeline_stage_dispatch_total', { stage: key });
    this.metrics.observe('pipeline_stage_active_jobs', jobCount, { stage: key });
  }
}

export { employeeSizeRequested } from '../search/search-plan.limits';

function hasNumericSize(size?: { min?: unknown; max?: unknown; exact?: unknown }): boolean {
  return Boolean(size && (typeof size.min === 'number' || typeof size.max === 'number' || typeof size.exact === 'number'));
}

function criteriaFromPlan(plan: unknown): ClassificationCriteria {
  const record = plan && typeof plan === 'object' ? plan as Partial<SearchPlan> : {};
  const leadType = record.leadTypes?.[0];
  const industry = record.industry?.[0];
  const location = record.locations?.[0];
  const companySize = record.companySize ?? record.employeeSize ?? record.employeeRange;
  const category = leadType ?? industry ?? record.category ?? 'UNSPECIFIED';
  return {
    category,
    ...(leadType ? { targetType: leadType } : {}),
    ...(location ? { location: { country: location.country, ...(location.state ? { states: [location.state] } : {}) } } : {}),
    ...(companySize && hasNumericSize(companySize) ? { companySize } : {}),
    requiredSignals: record.requiredFields ?? [],
    excludedSignals: [],
  };
}
