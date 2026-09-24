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
import type { PipelineCounters, PipelineFailure, PipelineProgressState, StageMap } from './pipeline.types';

const STAGE_STATES = new Set<StageState>(['PENDING', 'RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED']);

export function emptyStageMap(): StageMap {
  return {
    search: 'PENDING',
    sourceDiscovery: 'PENDING',
    companyPersistence: 'PENDING',
    websiteDiscovery: 'PENDING',
    enrichment: 'PENDING',
    deepResearch: 'PENDING',
    decisionMakerDiscovery: 'PENDING',
    contactQuality: 'PENDING',
    evidence: 'PENDING',
    classification: 'PENDING',
    verification: 'PENDING',
    deduplication: 'PENDING',
    scoring: 'PENDING',
    qualification: 'PENDING',
  };
}

export function initialProgress(): PipelineProgressState {
  const stages = emptyStageMap();
  stages.search = 'RUNNING';
  return { stages, jobs: {}, waits: 0, failures: [] };
}

export function parseProgress(value: unknown): PipelineProgressState {
  const stages = emptyStageMap();
  if (!value || typeof value !== 'object') return { stages, jobs: {}, waits: 0, failures: [] };
  const record = value as { stages?: Partial<StageMap>; jobs?: PipelineProgressState['jobs']; waits?: number; failures?: unknown };
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
  return { stages, jobs, waits: Number.isInteger(record.waits) && (record.waits ?? 0) >= 0 ? record.waits ?? 0 : 0, failures: readFailures(record) };
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
  if (first.length > 300 || /at\s+\S+\s+\(/.test(first) || /postgres|redis:|api[_-]?key|bearer |econn|secret/i.test(first)) return 'Pipeline stage failed.';
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

export type ObservedJobState = 'completed' | 'failed' | 'pending' | 'missing';

export function summarizeJobStates(states: ObservedJobState[], failureMessage: string): { state: 'COMPLETED' } | { state: 'PENDING' } | { state: 'FAILED'; message: string } | { state: 'PARTIAL'; message: string } {
  if (states.length === 0) return { state: 'COMPLETED' };
  if (states.some((state) => state === 'pending')) return { state: 'PENDING' };
  const failed = states.filter((state) => state === 'failed').length;
  const completed = states.length - failed;
  if (failed > 0 && completed === 0) return { state: 'FAILED', message: failureMessage };
  if (failed > 0) return { state: 'PARTIAL', message: failureMessage };
  return { state: 'COMPLETED' };
}

export function readFailures(record: { failures?: unknown }): PipelineFailure[] {
  if (!Array.isArray(record.failures)) return [];
  return record.failures.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const stage = 'stage' in item && typeof item.stage === 'string' ? item.stage : '';
    const message = 'message' in item && typeof item.message === 'string' ? publicErrorMessage(item.message) : '';
    return stage && message ? [{ stage, message }] : [];
  });
}

export function stageList(stages: StageMap) {
  const names: Array<[string, StageProgressKey]> = [
    ['SEARCH', 'search'],
    ['DISCOVERY', 'sourceDiscovery'],
    ['COMPANY_PERSISTENCE', 'companyPersistence'],
    ['WEBSITE_DISCOVERY', 'websiteDiscovery'],
    ['ENRICHMENT', 'enrichment'],
    ['DEEP_RESEARCH', 'deepResearch'],
    ['DECISION_MAKER_DISCOVERY', 'decisionMakerDiscovery'],
    ['CONTACT_QUALITY', 'contactQuality'],
    ['EVIDENCE', 'evidence'],
    ['CLASSIFICATION', 'classification'],
    ['VERIFICATION', 'verification'],
    ['DEDUPLICATION', 'deduplication'],
    ['SCORING', 'scoring'],
    ['QUALIFICATION', 'qualification'],
  ];
  return names.map(([name, key]) => ({ name, status: stages[key] }));
}

export function emptyCounters(): PipelineCounters {
  return {
    companiesDiscovered: null,
    companiesProcessed: null,
    websitesResearched: null,
    decisionMakersFound: null,
    contactsFound: null,
    evidenceCollected: null,
    verifiedFields: null,
    conflictsFound: null,
    duplicatesFound: null,
    qualifiedLeads: null,
  };
}

export function maskCounters(stages: StageMap, counts: PipelineCounters): PipelineCounters {
  const ready = (key: StageProgressKey) => stages[key] !== 'PENDING';
  return {
    companiesDiscovered: ready('sourceDiscovery') ? counts.companiesDiscovered : null,
    companiesProcessed: ready('companyPersistence') ? counts.companiesProcessed : null,
    websitesResearched: ready('deepResearch') ? counts.websitesResearched : null,
    decisionMakersFound: ready('decisionMakerDiscovery') ? counts.decisionMakersFound : null,
    contactsFound: ready('decisionMakerDiscovery') ? counts.contactsFound : null,
    evidenceCollected: ready('evidence') ? counts.evidenceCollected : null,
    verifiedFields: ready('verification') ? counts.verifiedFields : null,
    conflictsFound: ready('verification') ? counts.conflictsFound : null,
    duplicatesFound: ready('deduplication') ? counts.duplicatesFound : null,
    qualifiedLeads: ready('qualification') ? counts.qualifiedLeads : null,
  };
}

export function hasPartialStage(stages: StageMap): boolean {
  return Object.values(stages).includes('PARTIAL');
}
