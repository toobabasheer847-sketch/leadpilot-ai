import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { SourceProviderError } from '../sources/providers/source-provider.error';
import {
  PIPELINE_STAGES,
  STAGE_PROGRESS_KEYS,
  type PipelineErrorCode,
  type PipelineStage,
  type StageProgressKey,
  type StageState,
  type WorkStage,
} from './pipeline.constants';
import type { StageMap } from './pipeline.types';
import type { PipelineProgressState } from './pipeline.types';

const STAGE_STATES = new Set<StageState>(['PENDING', 'RUNNING', 'COMPLETED', 'FAILED']);

export function emptyStageMap(): StageMap {
  return {
    sourceDiscovery: 'PENDING',
    companyPersistence: 'PENDING',
    websiteDiscovery: 'PENDING',
    enrichment: 'PENDING',
    decisionMakerDiscovery: 'PENDING',
    classification: 'PENDING',
    verification: 'PENDING',
    deduplication: 'PENDING',
    scoring: 'PENDING',
    qualification: 'PENDING',
  };
}

export function initialProgress(): PipelineProgressState {
  const stages = emptyStageMap();
  stages.sourceDiscovery = 'RUNNING';
  return { stages, jobs: {}, waits: 0 };
}

export function parseProgress(value: unknown): PipelineProgressState {
  const stages = emptyStageMap();
  if (!value || typeof value !== 'object') return { stages, jobs: {}, waits: 0 };
  const record = value as { stages?: Partial<StageMap>; jobs?: PipelineProgressState['jobs']; waits?: number };
  for (const key of Object.keys(stages) as StageProgressKey[]) {
    const state = record.stages?.[key];
    if (state && STAGE_STATES.has(state)) stages[key] = state;
  }
  const jobs: PipelineProgressState['jobs'] = {};
  if (record.jobs && typeof record.jobs === 'object') {
    for (const [key, ids] of Object.entries(record.jobs)) {
      if (Array.isArray(ids) && ids.every((id) => typeof id === 'string')) jobs[key as StageProgressKey] = ids;
    }
  }
  return { stages, jobs, waits: Number.isInteger(record.waits) && (record.waits ?? 0) >= 0 ? record.waits ?? 0 : 0 };
}

export function isPipelineStage(value: string): value is PipelineStage {
  return (PIPELINE_STAGES as readonly string[]).includes(value);
}

export function progressKey(stage: string): StageProgressKey | null {
  if (!isPipelineStage(stage) || stage === 'COMPLETED') return null;
  return STAGE_PROGRESS_KEYS[stage as WorkStage];
}

export function nextWorkStage(stage: WorkStage): PipelineStage {
  const index = PIPELINE_STAGES.indexOf(stage);
  return PIPELINE_STAGES[index + 1] ?? 'COMPLETED';
}

export function withStageState(progress: PipelineProgressState, key: StageProgressKey, state: StageState): PipelineProgressState {
  return { ...progress, stages: { ...progress.stages, [key]: state } };
}

export function pipelineJobId(pipelineExecutionId: string, stage: string, wait = 0): string {
  const stageKey = stage.toLowerCase().replaceAll('_', '-');
  const base = `lead-pipeline-${pipelineExecutionId}-${stageKey}`;
  return wait > 0 ? `${base}-wait-${wait}` : base;
}

export function publicErrorMessage(message: string): string {
  const first = message.split('\n')[0]?.trim() || 'Pipeline stage failed.';
  if (first.length > 300 || /at\s+\S+\s+\(/.test(first)) return 'Pipeline stage failed.';
  return first;
}

export function classifyPipelineError(error: unknown): { code: PipelineErrorCode; message: string; retryable: boolean } {
  if (error instanceof SourceProviderError) {
    const message = publicErrorMessage(error.message);
    const code = String(error.code);
    if (code === 'PROVIDER_NOT_CONFIGURED' || code === 'PROVIDER_AUTH_ERROR' || code === 'PROVIDER_QUOTA_EXCEEDED' || code === 'NOT_CONFIGURED' || code === 'AUTHENTICATION') return { code: 'CONFIGURATION_ERROR', message, retryable: false };
    if (code === 'PROVIDER_INVALID_REQUEST' || code === 'INVALID_REQUEST' || code === 'MALFORMED_RESPONSE') return { code: 'VALIDATION_ERROR', message, retryable: false };
    if (code === 'PROVIDER_RATE_LIMITED' || code === 'PROVIDER_TIMEOUT' || code === 'PROVIDER_UNAVAILABLE' || code === 'PROVIDER_UNKNOWN_ERROR' || code === 'RATE_LIMITED' || code === 'TIMEOUT' || code === 'NETWORK_ERROR' || code === 'PROVIDER_ERROR') {
      return { code: 'TRANSIENT_PROVIDER_ERROR', message, retryable: true };
    }
  }

  const raw = error instanceof Error ? error.message : 'Pipeline stage failed.';
  const message = publicErrorMessage(raw);
  if (/not configured|openrouter_model|google_places_api_key/i.test(raw)) return { code: 'CONFIGURATION_ERROR', message, retryable: false };
  if (/rate limit|timed out|timeout|econnreset|temporarily unavailable/i.test(raw)) return { code: 'TRANSIENT_PROVIDER_ERROR', message, retryable: true };
  if (error instanceof NotFoundException || /\bnot found\b/i.test(raw)) return { code: 'NOT_FOUND', message, retryable: false };
  if (error instanceof ForbiddenException || /forbidden|permission/i.test(raw)) return { code: 'PERMISSION_ERROR', message, retryable: false };
  if (error instanceof BadRequestException || /validation/i.test(raw)) return { code: 'VALIDATION_ERROR', message, retryable: false };
  return { code: 'INTERNAL_ERROR', message: 'Pipeline stage failed.', retryable: false };
}

export function shouldRetryPipelineFailure(retryable: boolean, attemptsMade: number, attempts: number): boolean {
  return retryable && attemptsMade + 1 < attempts;
}
