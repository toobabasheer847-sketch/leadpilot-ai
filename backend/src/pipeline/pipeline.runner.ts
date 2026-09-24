import { Injectable } from '@nestjs/common';
import type { SearchPlan } from '../search/types/search-plan.types';
import type { ClassificationCriteria } from '../ai/classification/types/classification.types';
import { EnrichmentService } from '../enrichment/enrichment.service';
import { ContactsService } from '../contacts/contacts.service';
import { ClassificationService } from '../ai/classification/classification.service';
import { VerificationService } from '../verification/verification.service';
import { DeduplicationService } from '../deduplication/deduplication.service';
import { ScoringService } from '../scoring/scoring.service';
import { QualificationService } from '../qualification/qualification.service';
import { ResearchService } from '../research/research.service';
import { ContactQualityService } from '../contacts/quality/contact-quality.service';
import { TRACKED_QUEUES, type PipelineErrorCode, type WorkStage } from './pipeline.constants';
import { PipelineJobInspector } from './pipeline.job-inspector';
import { classifyPipelineError, nextWorkStage, progressKey, withStageState } from './pipeline.progress';
import { PipelineRepository, type PipelineExecutionRow } from './pipeline.repository';
import type { PipelineProgressState, StageTick } from './pipeline.types';

type TrackedKey = keyof typeof TRACKED_QUEUES;

const KEY_TO_STAGE: Record<TrackedKey, WorkStage> = {
  websiteDiscovery: 'WEBSITE_DISCOVERY',
  enrichment: 'ENRICHMENT',
  deepResearch: 'DEEP_RESEARCH',
  decisionMakerDiscovery: 'DECISION_MAKER_DISCOVERY',
  contactQuality: 'CONTACT_QUALITY',
  classification: 'CLASSIFICATION',
  verification: 'VERIFICATION',
  deduplication: 'DEDUPLICATION',
  scoring: 'SCORING',
  qualification: 'QUALIFICATION',
};

@Injectable()
export class PipelineStageRunner {
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
    private readonly jobs: PipelineJobInspector,
  ) {}

  tick(row: PipelineExecutionRow, progress: PipelineProgressState): Promise<StageTick> {
    switch (row.currentStage) {
      case 'SEARCH':
        return this.tickSearch(row, progress);
      case 'SOURCE_DISCOVERY':
      case 'COMPANY_PERSISTENCE':
        return this.tickDiscovery(row, progress, row.currentStage);
      case 'WEBSITE_DISCOVERY':
        return this.tickTracked(row, progress, 'websiteDiscovery');
      case 'ENRICHMENT':
        return this.finishTracked(progress, 'enrichment', progress.jobs.websiteDiscovery ?? []);
      case 'DEEP_RESEARCH':
        return this.tickTracked(row, progress, 'deepResearch');
      case 'DECISION_MAKER_DISCOVERY':
        return this.tickTracked(row, progress, 'decisionMakerDiscovery');
      case 'CONTACT_QUALITY':
        return this.tickTracked(row, progress, 'contactQuality');
      case 'EVIDENCE':
        return this.tickEvidence(row, progress);
      case 'CLASSIFICATION':
        return this.tickTracked(row, progress, 'classification');
      case 'VERIFICATION':
        return this.tickTracked(row, progress, 'verification');
      case 'DEDUPLICATION':
        return this.tickTracked(row, progress, 'deduplication');
      case 'SCORING':
        return this.tickTracked(row, progress, 'scoring');
      case 'QUALIFICATION':
        return this.tickQualification(row, progress);
      default:
        return Promise.resolve(this.fail(progress, 'SOURCE_DISCOVERY', 'INTERNAL_ERROR', 'Pipeline stage failed.'));
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
    const companyIds = await this.repository.listCompanyIds(row.organizationId, row.searchExecutionId);
    await this.repository.countEvidence(row.organizationId, companyIds);
    return this.move(progress, 'evidence', nextWorkStage('EVIDENCE'));
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
      const dispatched = { ...progress, jobs: { ...progress.jobs, [key]: jobIds }, stages: { ...progress.stages, [key]: 'RUNNING' as const } };
      if (jobIds.length === 0) return this.advance(dispatched, key);
      return { type: 'wait', progress: dispatched };
    }
    return this.finishTracked(progress, key, progress.jobs[key] ?? []);
  }

  private async finishTracked(progress: PipelineProgressState, key: TrackedKey, jobIds: string[]): Promise<StageTick> {
    const settlement = await this.jobs.settle(TRACKED_QUEUES[key], jobIds);
    if (settlement.state === 'PENDING') return { type: 'wait', progress: withStageState(progress, key, 'RUNNING') };
    if (settlement.state === 'FAILED') {
      const classified = classifyPipelineError(new Error(settlement.message));
      return this.fail(progress, KEY_TO_STAGE[key], classified.code, classified.message);
    }
    if (settlement.state === 'PARTIAL') {
      const failures = [...progress.failures, { stage: KEY_TO_STAGE[key], message: settlement.message }];
      return this.advance({ ...progress, failures }, key, 'PARTIAL');
    }
    return this.advance(progress, key);
  }

  private async tickQualification(row: PipelineExecutionRow, progress: PipelineProgressState): Promise<StageTick> {
    if (!row.searchExecutionId) return this.fail(progress, 'QUALIFICATION', 'NOT_FOUND', 'Search execution not found');
    if (!progress.jobs.qualification) {
      const result = await this.qualification.enqueueExecution(row.searchExecutionId, row.organizationId, false);
      const jobIds = result.status === 'QUEUED' && 'jobId' in result && result.jobId ? [String(result.jobId)] : [];
      const dispatched = { ...withStageState(progress, 'qualification', 'RUNNING'), jobs: { ...progress.jobs, qualification: jobIds } };
      if (jobIds.length === 0) return { type: 'complete', progress: withStageState({ ...dispatched, waits: 0 }, 'qualification', 'COMPLETED') };
      return { type: 'wait', progress: dispatched };
    }
    return this.finishTracked(progress, 'qualification', progress.jobs.qualification ?? []);
  }

  private async dispatch(row: PipelineExecutionRow, key: TrackedKey): Promise<string[]> {
    if (key === 'websiteDiscovery') {
      if (!row.searchExecutionId) return [];
      const enqueued = await this.enrichment.enqueueCompanyEnrichment(row.searchExecutionId, row.organizationId);
      return enqueued.flatMap((item) => item.jobId ? [String(item.jobId)] : []);
    }
    if (key === 'contactQuality') return this.dispatchContactQuality(row);
    if (!row.searchExecutionId) return [];
    const companyIds = await this.repository.listCompanyIds(row.organizationId, row.searchExecutionId);
    const jobIds: string[] = [];
    for (const companyId of companyIds) {
      const jobId = await this.dispatchCompany(row, key, companyId);
      if (jobId) jobIds.push(jobId);
    }
    return jobIds;
  }

  private async dispatchCompany(row: PipelineExecutionRow, key: TrackedKey, companyId: string): Promise<string | null> {
    if (key === 'deepResearch') {
      return this.research.enqueueTracked(companyId, row.organizationId);
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
      const result = await this.verification.enqueueCompany(companyId, row.organizationId, false, row.searchExecutionId);
      return result.status === 'QUEUED' && 'jobId' in result && result.jobId ? String(result.jobId) : null;
    }
    if (key === 'deduplication') {
      const result = await this.deduplication.enqueueCompany(companyId, row.organizationId);
      return result.jobId ? String(result.jobId) : null;
    }
    if (key === 'scoring') {
      const result = await this.scoring.enqueueCompany(companyId, row.organizationId, false, row.searchExecutionId);
      return result.status === 'QUEUED' && result.jobId ? String(result.jobId) : null;
    }
    return null;
  }

  private async dispatchContactQuality(row: PipelineExecutionRow): Promise<string[]> {
    if (!row.searchExecutionId) return [];
    const companyIds = await this.repository.listCompanyIds(row.organizationId, row.searchExecutionId);
    const contacts = await this.repository.listContactIds(row.organizationId, companyIds);
    const jobIds: string[] = [];
    for (const contact of contacts) {
      const result = await this.contactQuality.enqueue(contact.companyId, contact.id, row.organizationId);
      if (result.jobId) jobIds.push(String(result.jobId));
    }
    return jobIds;
  }

  private move(progress: PipelineProgressState, completedKey: TrackedKey | 'sourceDiscovery' | 'companyPersistence' | 'search' | 'evidence', next: WorkStage | 'COMPLETED', outcome: 'COMPLETED' | 'PARTIAL' = 'COMPLETED'): StageTick {
    const completed = withStageState(progress, completedKey, outcome);
    if (next === 'COMPLETED') return { type: 'complete', progress: { ...completed, waits: 0 } };
    const nextKey = progressKey(next);
    const running = nextKey ? withStageState(completed, nextKey, 'RUNNING') : completed;
    return { type: 'advance', currentStage: next, progress: { ...running, waits: 0 } };
  }

  private advance(progress: PipelineProgressState, key: TrackedKey, outcome: 'COMPLETED' | 'PARTIAL' = 'COMPLETED'): StageTick {
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
}

function criteriaFromPlan(plan: unknown): ClassificationCriteria {
  const record = plan && typeof plan === 'object' ? plan as Partial<SearchPlan> : {};
  const leadType = record.leadTypes?.[0];
  const industry = record.industry?.[0];
  const location = record.locations?.[0];
  return {
    category: leadType ?? industry ?? 'UNSPECIFIED',
    ...(leadType ? { targetType: leadType } : {}),
    ...(location ? { location: { country: location.country, ...(location.state ? { states: [location.state] } : {}) } } : {}),
    ...(record.companySize ? { companySize: record.companySize } : {}),
    requiredSignals: record.requiredFields ?? [],
    excludedSignals: [],
  };
}
