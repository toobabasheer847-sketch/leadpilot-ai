import type { PipelineErrorCode, PipelineStage, PipelineStatus, StageProgressKey, StageState } from './pipeline.constants';

export interface LeadPipelineJobData {
  pipelineExecutionId: string;
  organizationId: string;
  userId: string;
  searchId: string;
  searchExecutionId: string;
}

export type StageMap = Record<StageProgressKey, StageState>;

export interface PipelineFailure {
  stage: string;
  message: string;
}

/** Per-stage timing / load signals for Phase M dependency optimization. */
export interface StageTimingMetrics {
  startedAtMs: number | null;
  completedAtMs: number | null;
  durationMs: number | null;
  waitingMs: number | null;
  activeJobs: number;
  failedJobs: number;
  retryCount: number;
}

export interface PipelineStageMetrics {
  stages: Partial<Record<StageProgressKey, StageTimingMetrics>>;
  concurrencyLimit: number | null;
  dispatchBatches: number;
  providerRequestCount: number;
  /** Phase O: one bounded completeness pass after post-enrichment parallel. */
  completenessPassDone?: boolean;
  completenessFieldsFilled?: number;
  completenessCompaniesRetried?: number;
}

export interface PipelineProgressState {
  stages: StageMap;
  jobs: Partial<Record<StageProgressKey, string[]>>;
  waits: number;
  failures: PipelineFailure[];
  metrics?: PipelineStageMetrics;
}

export interface PipelineCounters {
  companiesDiscovered: number | null;
  companiesPersisted: number | null;
  companiesProcessed: number | null;
  requestedCount: number | null;
  /** SearchPlan countIntent: exact | maximum | minimum | approximate */
  countIntent: string | null;
  discoveryShortfall: number | null;
  discoveryRejected: number | null;
  discoveryDuplicatesRemoved: number | null;
  discoveryProviderQueries: number | null;
  /** Phase Q — provider status lines joined for UI (no secrets). */
  discoveryProviderStatusSummary: string | null;
  discoveryProvidersAttempted: number | null;
  discoveryProvidersSucceeded: number | null;
  discoveryProvidersFailed: number | null;
  discoveryProvidersSkipped: number | null;
  discoveryQueriesSkipped: number | null;
  companySizeRequested: boolean | null;
  websitesFound: number | null;
  websitesNotFound: number | null;
  websitesResearched: number | null;
  companySizeFound: number | null;
  companySizeUnknown: number | null;
  decisionMakersFound: number | null;
  decisionMakerEmailsFound: number | null;
  companyEmailsFound: number | null;
  socialProfilesFound: number | null;
  contactsFound: number | null;
  evidenceCollected: number | null;
  verifiedFields: number | null;
  conflictsFound: number | null;
  duplicatesFound: number | null;
  qualifiedLeads: number | null;
  /** requestedCount − qualifiedLeads when a count was requested (never invents leads). */
  qualifiedShortfall: number | null;
  needsReview: number | null;
  rejected: number | null;
}

export interface PipelineStageStatus {
  name: string;
  status: StageState;
}

export interface PipelineView {
  pipelineExecutionId: string;
  executionId: string | null;
  searchId: string;
  searchExecutionId: string | null;
  status: PipelineStatus;
  currentStage: PipelineStage;
  startedAt: Date | null;
  completedAt: Date | null;
  failedAt: Date | null;
  stages: StageMap;
  stageList: PipelineStageStatus[];
  counters: PipelineCounters;
  failures: PipelineFailure[];
  error: { code: PipelineErrorCode; message: string } | null;
}

export type StageTick =
  | { type: 'wait'; progress: PipelineProgressState }
  | { type: 'advance'; currentStage: PipelineStage; progress: PipelineProgressState }
  | { type: 'complete'; progress: PipelineProgressState }
  | { type: 'fail'; errorCode: PipelineErrorCode; errorMessage: string; progress: PipelineProgressState };
