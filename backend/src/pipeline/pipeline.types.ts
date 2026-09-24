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

export interface PipelineProgressState {
  stages: StageMap;
  jobs: Partial<Record<StageProgressKey, string[]>>;
  waits: number;
  failures: PipelineFailure[];
}

export interface PipelineCounters {
  companiesDiscovered: number | null;
  companiesProcessed: number | null;
  websitesResearched: number | null;
  decisionMakersFound: number | null;
  contactsFound: number | null;
  evidenceCollected: number | null;
  verifiedFields: number | null;
  conflictsFound: number | null;
  duplicatesFound: number | null;
  qualifiedLeads: number | null;
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
