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
import type { PipelineCounters, PipelineFailure, PipelineProgressState, PipelineStageMetrics, StageMap, StageTimingMetrics } from './pipeline.types';

const STAGE_STATES = new Set<StageState>(['PENDING', 'RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED', 'SKIPPED']);

export function emptyStageMap(): StageMap {
  return {
    search: 'PENDING',
    sourceDiscovery: 'PENDING',
    companyPersistence: 'PENDING',
    websiteDiscovery: 'PENDING',
    enrichment: 'PENDING',
    deepResearch: 'PENDING',
    employeeSize: 'PENDING',
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

export function emptyStageMetrics(concurrencyLimit: number | null = null): PipelineStageMetrics {
  return { stages: {}, concurrencyLimit, dispatchBatches: 0, providerRequestCount: 0 };
}

export function initialProgress(): PipelineProgressState {
  const stages = emptyStageMap();
  stages.search = 'RUNNING';
  return { stages, jobs: {}, waits: 0, failures: [], metrics: emptyStageMetrics() };
}

export function parseProgress(value: unknown): PipelineProgressState {
  const stages = emptyStageMap();
  if (!value || typeof value !== 'object') return { stages, jobs: {}, waits: 0, failures: [], metrics: emptyStageMetrics() };
  const record = value as {
    stages?: Partial<StageMap>;
    jobs?: PipelineProgressState['jobs'];
    waits?: number;
    failures?: unknown;
    metrics?: PipelineStageMetrics;
  };
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
  return {
    stages,
    jobs,
    waits: Number.isInteger(record.waits) && (record.waits ?? 0) >= 0 ? record.waits ?? 0 : 0,
    failures: readFailures(record),
    metrics: parseStageMetrics(record.metrics),
  };
}

function parseStageMetrics(value: unknown): PipelineStageMetrics {
  const empty = emptyStageMetrics();
  if (!value || typeof value !== 'object') return empty;
  const record = value as Partial<PipelineStageMetrics>;
  const stages: PipelineStageMetrics['stages'] = {};
  if (record.stages && typeof record.stages === 'object') {
    for (const [key, timing] of Object.entries(record.stages)) {
      if (!timing || typeof timing !== 'object') continue;
      const item = timing as StageTimingMetrics;
      stages[key as StageProgressKey] = {
        startedAtMs: typeof item.startedAtMs === 'number' ? item.startedAtMs : null,
        completedAtMs: typeof item.completedAtMs === 'number' ? item.completedAtMs : null,
        durationMs: typeof item.durationMs === 'number' ? item.durationMs : null,
        waitingMs: typeof item.waitingMs === 'number' ? item.waitingMs : null,
        activeJobs: typeof item.activeJobs === 'number' ? item.activeJobs : 0,
        failedJobs: typeof item.failedJobs === 'number' ? item.failedJobs : 0,
        retryCount: typeof item.retryCount === 'number' ? item.retryCount : 0,
      };
    }
  }
  return {
    stages,
    concurrencyLimit: typeof record.concurrencyLimit === 'number' ? record.concurrencyLimit : null,
    dispatchBatches: typeof record.dispatchBatches === 'number' ? record.dispatchBatches : 0,
    providerRequestCount: typeof record.providerRequestCount === 'number' ? record.providerRequestCount : 0,
    ...(typeof record.completenessPassDone === 'boolean' ? { completenessPassDone: record.completenessPassDone } : {}),
    ...(typeof record.completenessFieldsFilled === 'number' ? { completenessFieldsFilled: record.completenessFieldsFilled } : {}),
    ...(typeof record.completenessCompaniesRetried === 'number' ? { completenessCompaniesRetried: record.completenessCompaniesRetried } : {}),
  };
}

export function markStageStarted(
  progress: PipelineProgressState,
  key: StageProgressKey,
  activeJobs: number,
  now = Date.now(),
): PipelineProgressState {
  const metrics = progress.metrics ?? emptyStageMetrics();
  const previous = metrics.stages[key];
  return {
    ...progress,
    metrics: {
      ...metrics,
      dispatchBatches: metrics.dispatchBatches + 1,
      stages: {
        ...metrics.stages,
        [key]: {
          startedAtMs: previous?.startedAtMs ?? now,
          completedAtMs: null,
          durationMs: null,
          waitingMs: previous?.waitingMs ?? 0,
          activeJobs,
          failedJobs: previous?.failedJobs ?? 0,
          retryCount: previous?.retryCount ?? 0,
        },
      },
    },
  };
}

export function markStageCompleted(
  progress: PipelineProgressState,
  key: StageProgressKey,
  failedJobs = 0,
  now = Date.now(),
): PipelineProgressState {
  const metrics = progress.metrics ?? emptyStageMetrics();
  const previous = metrics.stages[key] ?? {
    startedAtMs: now,
    completedAtMs: null,
    durationMs: null,
    waitingMs: 0,
    activeJobs: 0,
    failedJobs: 0,
    retryCount: 0,
  };
  const started = previous.startedAtMs ?? now;
  return {
    ...progress,
    metrics: {
      ...metrics,
      stages: {
        ...metrics.stages,
        [key]: {
          ...previous,
          completedAtMs: now,
          durationMs: Math.max(0, now - started),
          waitingMs: previous.waitingMs ?? 0,
          activeJobs: 0,
          failedJobs,
        },
      },
    },
  };
}

export function accumulateWait(progress: PipelineProgressState, key: StageProgressKey, waitMs: number): PipelineProgressState {
  const metrics = progress.metrics ?? emptyStageMetrics();
  const previous = metrics.stages[key];
  if (!previous) return progress;
  return {
    ...progress,
    metrics: {
      ...metrics,
      stages: {
        ...metrics.stages,
        [key]: { ...previous, waitingMs: (previous.waitingMs ?? 0) + Math.max(0, waitMs) },
      },
    },
  };
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

  if (isOpenRouterError(error)) {
    const message = publicErrorMessage(error.message);
    if (error.code === 'NOT_CONFIGURED' || error.code === 'AUTHENTICATION') return { code: 'CONFIGURATION_ERROR', message, retryable: false };
    if (error.code === 'RATE_LIMITED' || error.code === 'TIMEOUT' || error.code === 'PROVIDER_ERROR') return { code: 'TRANSIENT_PROVIDER_ERROR', message, retryable: true };
    if (error.code === 'MODEL_NOT_FOUND' || error.code === 'INVALID_REQUEST' || error.code === 'PARSE_ERROR') return { code: 'VALIDATION_ERROR', message, retryable: false };
  }

  const raw = error instanceof Error ? error.message : 'Pipeline stage failed.';
  const message = publicErrorMessage(raw);
  if (/not configured|openrouter_model|google_places_api_key|authentication failed \(status 40[13]\)/i.test(raw)) return { code: 'CONFIGURATION_ERROR', message, retryable: false };
  if (/plan limit|pay-as-you-go limit|quota exceeded/i.test(raw)) return { code: 'CONFIGURATION_ERROR', message, retryable: false };
  if (/rate limit|timed out|timeout|econnreset|temporarily unavailable/i.test(raw)) return { code: 'TRANSIENT_PROVIDER_ERROR', message, retryable: true };
  if (error instanceof NotFoundException || /\bnot found\b/i.test(raw)) return { code: 'NOT_FOUND', message, retryable: false };
  if (error instanceof ForbiddenException || /forbidden|permission/i.test(raw)) return { code: 'PERMISSION_ERROR', message, retryable: false };
  if (error instanceof BadRequestException || /validation|status 400|status 404|malformed classification|invalid classification|invalid positive evidence|invalid negative evidence|invalid investor type|invalid missing evidence|invalid exclusion reason|invalid company size|invalid location status/i.test(raw)) return { code: 'VALIDATION_ERROR', message, retryable: false };
  const websiteFailure = classifyWebsiteDiscoveryMessage(raw) ?? classifyWebSearchMessage(raw);
  if (websiteFailure) return { ...websiteFailure, message };
  return { code: 'INTERNAL_ERROR', message: 'Pipeline stage failed.', retryable: false };
}

export const WEBSITE_PARTIAL_MESSAGE = 'No verified website found for some companies.';
export const ENRICHMENT_EMPTY_MESSAGE = 'No additional verified enrichment data found.';

function classifyWebSearchMessage(raw: string): { code: PipelineErrorCode; retryable: boolean } | null {
  if (raw.startsWith('Web search provider is not configured') || raw.startsWith('Web search provider authentication failed')) return { code: 'CONFIGURATION_ERROR', retryable: false };
  if (raw.includes('plan limit exceeded') || raw.includes('pay-as-you-go limit exceeded')) return { code: 'CONFIGURATION_ERROR', retryable: false };
  if (raw.startsWith('Web search provider timed out') || raw.startsWith('Web search provider rate limit') || raw.startsWith('Web search provider is unavailable')) return { code: 'TRANSIENT_PROVIDER_ERROR', retryable: true };
  if (/^Web search provider returned HTTP 5\d\d\.$/.test(raw)) return { code: 'TRANSIENT_PROVIDER_ERROR', retryable: true };
  if (/^Web search provider returned HTTP 4\d\d\.$/.test(raw)) return { code: 'VALIDATION_ERROR', retryable: false };
  if (raw.startsWith('Web search provider returned an invalid response')) return { code: 'VALIDATION_ERROR', retryable: false };
  return null;
}

function classifyWebsiteDiscoveryMessage(raw: string): { code: PipelineErrorCode; retryable: boolean } | null {
  if (/^No verified website found\b/i.test(raw)) return { code: 'NOT_FOUND', retryable: false };
  if (raw.startsWith('Website discovery provider is not configured')) return { code: 'CONFIGURATION_ERROR', retryable: false };
  if (raw.startsWith('Website discovery provider timed out') || raw.startsWith('Website discovery provider is unavailable')) return { code: 'TRANSIENT_PROVIDER_ERROR', retryable: true };
  if (/^Website discovery provider returned HTTP 5\d\d\.$/.test(raw)) return { code: 'TRANSIENT_PROVIDER_ERROR', retryable: true };
  if (/^Website discovery provider returned HTTP 4\d\d\.$/.test(raw)) return { code: 'VALIDATION_ERROR', retryable: false };
  if (raw.startsWith('Website discovery provider returned an invalid response')) return { code: 'VALIDATION_ERROR', retryable: false };
  return null;
}

export function summarizeWebsiteFindings(outcomes: Array<'FOUND' | 'NOT_FOUND'>): { state: 'COMPLETED' } | { state: 'PARTIAL'; message: string } | null {
  if (outcomes.length === 0) return null;
  const found = outcomes.some((item) => item === 'FOUND');
  const missing = outcomes.some((item) => item === 'NOT_FOUND');
  if (found && missing) return { state: 'PARTIAL', message: WEBSITE_PARTIAL_MESSAGE };
  return { state: 'COMPLETED' };
}

function isOpenRouterError(error: unknown): error is Error & { code: string } {
  return error instanceof Error && error.name === 'OpenRouterError' && 'code' in error;
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
    ['EMPLOYEE_SIZE', 'employeeSize'],
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
    companiesPersisted: null,
    companiesProcessed: null,
    requestedCount: null,
    countIntent: null,
    discoveryShortfall: null,
    discoveryRejected: null,
    discoveryDuplicatesRemoved: null,
    discoveryProviderQueries: null,
    discoveryProviderStatusSummary: null,
    discoveryProvidersAttempted: null,
    discoveryProvidersSucceeded: null,
    discoveryProvidersFailed: null,
    discoveryProvidersSkipped: null,
    discoveryQueriesSkipped: null,
    discoveryStopReason: null,
    discoveryRejectionSummary: null,
    discoveryLocationYieldSummary: null,
    discoveryCategoryYieldSummary: null,
    discoveryYieldPerQuery: null,
    discoveryEmptyFieldEnrichments: null,
    companySizeRequested: null,
    websitesFound: null,
    websitesNotFound: null,
    websitesResearched: null,
    companySizeFound: null,
    companySizeUnknown: null,
    decisionMakersFound: null,
    decisionMakerEmailsFound: null,
    companyEmailsFound: null,
    socialProfilesFound: null,
    contactsFound: null,
    evidenceCollected: null,
    verifiedFields: null,
    conflictsFound: null,
    duplicatesFound: null,
    qualifiedLeads: null,
    qualifiedShortfall: null,
    needsReview: null,
    rejected: null,
  };
}

export function maskCounters(stages: StageMap, counts: PipelineCounters): PipelineCounters {
  const ready = (key: StageProgressKey) => stages[key] !== 'PENDING';
  return {
    companiesDiscovered: ready('sourceDiscovery') ? counts.companiesDiscovered : null,
    companiesPersisted: ready('companyPersistence') ? counts.companiesPersisted : null,
    companiesProcessed: ready('companyPersistence') ? counts.companiesProcessed : null,
    requestedCount: counts.requestedCount,
    countIntent: counts.countIntent,
    discoveryShortfall: ready('sourceDiscovery') ? counts.discoveryShortfall : null,
    discoveryRejected: ready('sourceDiscovery') ? counts.discoveryRejected : null,
    discoveryDuplicatesRemoved: ready('sourceDiscovery') ? counts.discoveryDuplicatesRemoved : null,
    discoveryProviderQueries: ready('sourceDiscovery') ? counts.discoveryProviderQueries : null,
    discoveryProviderStatusSummary: ready('sourceDiscovery') ? counts.discoveryProviderStatusSummary : null,
    discoveryProvidersAttempted: ready('sourceDiscovery') ? counts.discoveryProvidersAttempted : null,
    discoveryProvidersSucceeded: ready('sourceDiscovery') ? counts.discoveryProvidersSucceeded : null,
    discoveryProvidersFailed: ready('sourceDiscovery') ? counts.discoveryProvidersFailed : null,
    discoveryProvidersSkipped: ready('sourceDiscovery') ? counts.discoveryProvidersSkipped : null,
    discoveryQueriesSkipped: ready('sourceDiscovery') ? counts.discoveryQueriesSkipped : null,
    discoveryStopReason: ready('sourceDiscovery') ? counts.discoveryStopReason : null,
    discoveryRejectionSummary: ready('sourceDiscovery') ? counts.discoveryRejectionSummary : null,
    discoveryLocationYieldSummary: ready('sourceDiscovery') ? counts.discoveryLocationYieldSummary : null,
    discoveryCategoryYieldSummary: ready('sourceDiscovery') ? counts.discoveryCategoryYieldSummary : null,
    discoveryYieldPerQuery: ready('sourceDiscovery') ? counts.discoveryYieldPerQuery : null,
    discoveryEmptyFieldEnrichments: ready('sourceDiscovery') ? counts.discoveryEmptyFieldEnrichments : null,
    companySizeRequested: counts.companySizeRequested,
    websitesFound: ready('websiteDiscovery') ? counts.websitesFound : null,
    websitesNotFound: ready('websiteDiscovery') ? counts.websitesNotFound : null,
    websitesResearched: ready('deepResearch') ? counts.websitesResearched : null,
    companySizeFound: counts.companySizeRequested && ready('employeeSize') ? counts.companySizeFound : null,
    companySizeUnknown: counts.companySizeRequested && ready('employeeSize') ? counts.companySizeUnknown : null,
    decisionMakersFound: ready('decisionMakerDiscovery') ? counts.decisionMakersFound : null,
    decisionMakerEmailsFound: ready('decisionMakerDiscovery') ? counts.decisionMakerEmailsFound : null,
    companyEmailsFound: ready('enrichment') ? counts.companyEmailsFound : null,
    socialProfilesFound: ready('enrichment') ? counts.socialProfilesFound : null,
    contactsFound: ready('decisionMakerDiscovery') ? counts.contactsFound : null,
    evidenceCollected: ready('evidence') ? counts.evidenceCollected : null,
    verifiedFields: ready('verification') ? counts.verifiedFields : null,
    conflictsFound: ready('verification') ? counts.conflictsFound : null,
    duplicatesFound: ready('deduplication') ? counts.duplicatesFound : null,
    qualifiedLeads: ready('qualification') ? counts.qualifiedLeads : null,
    qualifiedShortfall: ready('qualification') ? counts.qualifiedShortfall : null,
    needsReview: ready('qualification') ? counts.needsReview : null,
    rejected: ready('qualification') ? counts.rejected : null,
  };
}

export function hasPartialStage(stages: StageMap): boolean {
  return Object.values(stages).includes('PARTIAL');
}

export function isSettledStageState(state: StageState): boolean {
  return state === 'COMPLETED' || state === 'PARTIAL' || state === 'SKIPPED' || state === 'FAILED';
}
