import type { PipelineErrorCode, PipelineStage, PipelineStatus, StageProgressKey, StageState } from './pipeline.constants';

export interface LeadPipelineJobData {
  pipelineExecutionId: string;
  organizationId: string;
  userId: string;
  searchId: string;
  searchExecutionId: string;
}

export type StageMap = Record<StageProgressKey, StageState>;

export interface PipelineProgressState {
  stages: StageMap;
  jobs: Partial<Record<StageProgressKey, string[]>>;
  waits: number;
}

export interface PipelineView {
  pipelineExecutionId: string;
  searchId: string;
  searchExecutionId: string | null;
  status: PipelineStatus;
  currentStage: PipelineStage;
  startedAt: Date | null;
  completedAt: Date | null;
  failedAt: Date | null;
  stages: StageMap;
  error: { code: PipelineErrorCode; message: string } | null;
}

export type StageTick =
  | { type: 'wait'; progress: PipelineProgressState }
  | { type: 'advance'; currentStage: PipelineStage; progress: PipelineProgressState }
  | { type: 'complete'; progress: PipelineProgressState }
  | { type: 'fail'; errorCode: PipelineErrorCode; errorMessage: string; progress: PipelineProgressState };
