import { ConflictException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GooglePlacesProvider } from '../sources/providers/google-places/google-places.provider';
import { SourceProviderError } from '../sources/providers/source-provider.error';
import { OpenRouterProvider } from '../ai/classification/providers/openrouter.provider';
import {
  classifyPipelineError,
  initialProgress,
  maskCounters,
  parseProgress,
  nextWorkStage,
  pipelineJobId,
  shouldRetryPipelineFailure,
  summarizeJobStates,
} from './pipeline.progress';
import { PipelineService } from './pipeline.service';
import { PipelineStageRunner } from './pipeline.runner';
import type { PipelineExecutionRow } from './pipeline.repository';

const user = { id: 'user-1', email: 'user@example.com', name: 'User', organizationId: 'org-1', organizationName: 'Org', role: 'OWNER' };
const otherUser = { ...user, id: 'user-2', organizationId: 'org-2', organizationName: 'Other' };

function row(overrides: Partial<PipelineExecutionRow> = {}): PipelineExecutionRow {
  return {
    id: 'pipeline-1',
    organizationId: 'org-1',
    searchId: 'search-1',
    searchExecutionId: 'execution-1',
    status: 'QUEUED',
    currentStage: 'SOURCE_DISCOVERY',
    stageProgress: initialProgress(),
    startedAt: null,
    completedAt: null,
    failedAt: null,
    errorCode: null,
    errorMessage: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('pipeline orchestration', () => {
  it('creates a pipeline execution and enqueues a deterministic job', async () => {
    const repository = repositoryMock();
    const queue = { enqueue: jest.fn().mockResolvedValue({ id: 'job-1' }), removePending: jest.fn() };
    const searches = { findOne: jest.fn().mockResolvedValue({ id: 'search-1' }), createExecution: jest.fn().mockResolvedValue({ id: 'execution-1' }) };
    const service = new PipelineService(repository as never, searches as never, queue as never, {} as never, logger());
    repository.insert.mockImplementation(async (values: Partial<PipelineExecutionRow>) => row(values));

    const created = await service.start(user, 'search-1');

    expect(created).toMatchObject({ pipelineExecutionId: 'pipeline-1', executionId: 'execution-1', searchId: 'search-1', status: 'QUEUED', currentStage: 'SEARCH' });
    expect(queue.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      pipelineExecutionId: 'pipeline-1',
      organizationId: 'org-1',
      userId: 'user-1',
      searchId: 'search-1',
      searchExecutionId: 'execution-1',
    }), 'SEARCH', 0);
    expect(created.counters.companiesDiscovered).toBeNull();
  });

  it('reuses a queued or running pipeline for the same search', async () => {
    const repository = repositoryMock();
    const queue = { enqueue: jest.fn(), removePending: jest.fn() };
    const searches = { findOne: jest.fn().mockResolvedValue({ id: 'search-1' }), createExecution: jest.fn() };
    repository.findActive.mockResolvedValue(row({ status: 'RUNNING' }));
    const service = new PipelineService(repository as never, searches as never, queue as never, {} as never, logger());

    const existing = await service.start(user, 'search-1');

    expect(existing.pipelineExecutionId).toBe('pipeline-1');
    expect(searches.createExecution).not.toHaveBeenCalled();
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it('hides another organization pipeline', async () => {
    const repository = repositoryMock();
    const searches = {
      findOne: jest.fn().mockImplementation(async (current: typeof user) => {
        if (current.organizationId !== 'org-1') throw new NotFoundException('Search not found');
        return { id: 'search-1' };
      }),
    };
    repository.findLatest.mockResolvedValue(null);
    repository.findById.mockResolvedValue(null);
    const service = new PipelineService(repository as never, searches as never, { enqueue: jest.fn(), removePending: jest.fn() } as never, {} as never, logger());

    await expect(service.getForSearch(otherUser, 'search-1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.cancel(otherUser, 'pipeline-1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('advances discovery into company persistence only after the execution completes', async () => {
    const runner = runnerWith({
      getSearchExecution: jest.fn().mockResolvedValue({ status: 'COMPLETED', errorMessage: null, structuredPlan: {} }),
    });
    const tick = await runner.tick(row(), initialProgress());
    expect(tick).toMatchObject({ type: 'advance', currentStage: 'COMPANY_PERSISTENCE' });
    if (tick.type === 'advance') expect(tick.progress.stages.sourceDiscovery).toBe('COMPLETED');
  });

  it('records a configuration failure and does not complete the pipeline', async () => {
    const repository = repositoryMock();
    const created = row();
    repository.findById.mockResolvedValue(created);
    repository.update.mockImplementation(async (_org: string, _id: string, values: Partial<PipelineExecutionRow>) => ({ ...created, ...values }));
    const runner = { tick: jest.fn().mockResolvedValue({ type: 'fail', errorCode: 'CONFIGURATION_ERROR', errorMessage: 'Google Places provider is not configured.', progress: initialProgress() }) };
    const service = new PipelineService(repository as never, {} as never, { enqueue: jest.fn(), removePending: jest.fn() } as never, runner as never, logger());

    await service.runTick({ pipelineExecutionId: 'pipeline-1', organizationId: 'org-1', userId: 'user-1', searchId: 'search-1', searchExecutionId: 'execution-1' }, 0, 3);

    expect(repository.update).toHaveBeenCalledWith('org-1', 'pipeline-1', expect.objectContaining({ status: 'FAILED', errorCode: 'CONFIGURATION_ERROR' }));
    expect(repository.update).not.toHaveBeenCalledWith('org-1', 'pipeline-1', expect.objectContaining({ status: 'COMPLETED' }));
  });

  it('retries a transient provider failure and persists it when attempts are exhausted', async () => {
    expect(shouldRetryPipelineFailure(true, 0, 3)).toBe(true);
    expect(shouldRetryPipelineFailure(true, 2, 3)).toBe(false);
    expect(classifyPipelineError(new SourceProviderError('PROVIDER_RATE_LIMITED', 'Google Places provider rate limit reached.')).retryable).toBe(true);
    expect(classifyPipelineError(new SourceProviderError('PROVIDER_NOT_CONFIGURED', 'Google Places provider is not configured.')).retryable).toBe(false);

    const repository = repositoryMock();
    const created = row({ status: 'RUNNING' });
    repository.findById.mockResolvedValue(created);
    const runner = { tick: jest.fn().mockRejectedValue(new SourceProviderError('PROVIDER_TIMEOUT', 'Google Places provider request timed out.')) };
    const service = new PipelineService(repository as never, {} as never, { enqueue: jest.fn(), removePending: jest.fn() } as never, runner as never, logger());

    await expect(service.runTick({ pipelineExecutionId: 'pipeline-1', organizationId: 'org-1', userId: 'user-1', searchId: 'search-1', searchExecutionId: 'execution-1' }, 0, 3)).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });
    expect(repository.update).not.toHaveBeenCalled();

    await service.runTick({ pipelineExecutionId: 'pipeline-1', organizationId: 'org-1', userId: 'user-1', searchId: 'search-1', searchExecutionId: 'execution-1' }, 2, 3);
    expect(repository.update).toHaveBeenCalledWith('org-1', 'pipeline-1', expect.objectContaining({ status: 'FAILED', errorCode: 'TRANSIENT_PROVIDER_ERROR' }));
  });

  it('cancels a queued pipeline without marking it completed', async () => {
    const repository = repositoryMock();
    const active = row({ status: 'RUNNING' });
    repository.findById.mockResolvedValueOnce(active).mockResolvedValueOnce({ ...active, status: 'CANCELLED' });
    repository.update.mockResolvedValue({ ...active, status: 'CANCELLED' });
    const queue = { enqueue: jest.fn(), removePending: jest.fn() };
    const service = new PipelineService(repository as never, { findOne: jest.fn() } as never, queue as never, {} as never, logger());

    const cancelled = await service.cancel(user, 'pipeline-1');

    expect(cancelled.status).toBe('CANCELLED');
    expect(queue.removePending).toHaveBeenCalledWith('pipeline-1', 'SOURCE_DISCOVERY', 0);
    await expect(service.cancel(user, 'pipeline-1')).rejects.toBeInstanceOf(ConflictException);
  });

  it('marks the pipeline completed from persisted stage progress', async () => {
    const repository = repositoryMock();
    const running = row({ status: 'RUNNING', currentStage: 'QUALIFICATION' });
    repository.findById.mockResolvedValue(running);
    repository.update.mockImplementation(async (_org: string, _id: string, values: Partial<PipelineExecutionRow>) => ({ ...running, ...values }));
    const progress = initialProgress();
    progress.stages.qualification = 'COMPLETED';
    const runner = { tick: jest.fn().mockResolvedValue({ type: 'complete', progress }) };
    const service = new PipelineService(repository as never, {} as never, { enqueue: jest.fn(), removePending: jest.fn() } as never, runner as never, logger());

    await service.runTick({ pipelineExecutionId: 'pipeline-1', organizationId: 'org-1', userId: 'user-1', searchId: 'search-1', searchExecutionId: 'execution-1' }, 0, 3);

    expect(repository.update).toHaveBeenCalledWith('org-1', 'pipeline-1', expect.objectContaining({ status: 'COMPLETED', currentStage: 'COMPLETED' }));
  });

  it('reports a missing Google Places configuration without fabricating companies', async () => {
    const provider = new GooglePlacesProvider({ fetch: jest.fn() } as never, config({}));
    await expect(provider.search({ industry: [], leadTypes: [], locations: [], companyFields: [], unresolvedCriteria: [] }, { organizationId: 'org-1', searchExecutionId: 'execution-1' })).rejects.toBeInstanceOf(SourceProviderError);
    const failure = classifyPipelineError(new SourceProviderError('PROVIDER_NOT_CONFIGURED', 'Google Places provider is not configured.'));
    expect(failure).toMatchObject({ code: 'CONFIGURATION_ERROR', retryable: false });
  });

  it('reports a missing OpenRouter model without fabricating a classification', async () => {
    const provider = new OpenRouterProvider(config({ 'openRouter.apiKey': 'present', 'openRouter.model': undefined }));
    await expect(provider.classify({ company: { id: 'company-1', name: 'Stored company', description: null, website: null, category: null, investorType: null, investmentStrategy: null, employeeCount: null, employeeRange: null }, criteria: { category: 'UNSPECIFIED' }, evidence: [] })).rejects.toThrow(/not configured/);
    expect(classifyPipelineError(new Error('OpenRouter is not configured'))).toMatchObject({ code: 'CONFIGURATION_ERROR', retryable: false });
  });

  it('runs deep website research after enrichment in the existing pipeline', () => {
    expect(nextWorkStage('ENRICHMENT')).toBe('DEEP_RESEARCH');
    expect(nextWorkStage('DEEP_RESEARCH')).toBe('DECISION_MAKER_DISCOVERY');
    expect(nextWorkStage('DECISION_MAKER_DISCOVERY')).toBe('CONTACT_QUALITY');
    expect(nextWorkStage('CONTACT_QUALITY')).toBe('EVIDENCE');
    expect(nextWorkStage('EVIDENCE')).toBe('CLASSIFICATION');
    expect(pipelineJobId('pipeline-1', 'DEEP_RESEARCH')).toBe('lead-pipeline-pipeline-1-deep-research');
    expect(pipelineJobId('pipeline-1', 'DEEP_RESEARCH')).not.toContain(':');
  });
  it('builds deterministic job ids without colons', () => {
    const first = pipelineJobId('pipeline-1', 'SOURCE_DISCOVERY', 0);
    const second = pipelineJobId('pipeline-1', 'SOURCE_DISCOVERY', 2);
    expect(first).toBe('lead-pipeline-pipeline-1-source-discovery');
    expect(second).toBe('lead-pipeline-pipeline-1-source-discovery-wait-2');
    expect(first).toBe(pipelineJobId('pipeline-1', 'SOURCE_DISCOVERY'));
    expect(`${first}${second}`).not.toContain(':');
  });

  it('keeps persisted progress instead of inventing stage results', () => {
    const progress = parseProgress({ stages: { sourceDiscovery: 'COMPLETED', classification: 'NOT_A_STAGE' }, waits: 1 });
    expect(progress.stages.sourceDiscovery).toBe('COMPLETED');
    expect(progress.stages.classification).toBe('PENDING');
    expect(progress.waits).toBe(1);
  });

  it('keeps a partial company failure from completing the whole pipeline as success', async () => {
    expect(summarizeJobStates(['completed', 'failed'], 'One company failed.')).toEqual({ state: 'PARTIAL', message: 'One company failed.' });
    expect(summarizeJobStates(['failed', 'failed'], 'All companies failed.')).toEqual({ state: 'FAILED', message: 'All companies failed.' });
    expect(summarizeJobStates(['pending', 'failed'], 'Waiting.')).toEqual({ state: 'PENDING' });

    const repository = repositoryMock();
    const running = row({ status: 'RUNNING', currentStage: 'QUALIFICATION' });
    repository.findById.mockResolvedValue(running);
    repository.update.mockImplementation(async (_org: string, _id: string, values: Partial<PipelineExecutionRow>) => ({ ...running, ...values }));
    const progress = initialProgress();
    progress.stages.qualification = 'PARTIAL';
    progress.failures = [{ stage: 'QUALIFICATION', message: 'One company failed.' }];
    const runner = { tick: jest.fn().mockResolvedValue({ type: 'complete', progress }) };
    const service = new PipelineService(repository as never, {} as never, { enqueue: jest.fn(), removePending: jest.fn() } as never, runner as never, logger());

    await service.runTick({ pipelineExecutionId: 'pipeline-1', organizationId: 'org-1', userId: 'user-1', searchId: 'search-1', searchExecutionId: 'execution-1' }, 0, 3);

    expect(repository.update).toHaveBeenCalledWith('org-1', 'pipeline-1', expect.objectContaining({ status: 'PARTIAL', currentStage: 'COMPLETED' }));
  });

  it('does not expose another organization execution', async () => {
    const repository = repositoryMock();
    repository.getSearchExecution = jest.fn().mockResolvedValue(null);
    const service = new PipelineService(repository as never, {} as never, { enqueue: jest.fn(), removePending: jest.fn() } as never, {} as never, logger());
    await expect(service.getByExecution(otherUser, 'execution-1')).rejects.toBeInstanceOf(NotFoundException);
    expect(repository.findBySearchExecution).not.toHaveBeenCalled();
  });

  it('hides counters for stages that have not started', () => {
    const stages = initialProgress().stages;
    stages.sourceDiscovery = 'COMPLETED';
    const masked = maskCounters(stages, {
      companiesDiscovered: 2,
      companiesProcessed: 0,
      websitesResearched: 0,
      decisionMakersFound: 0,
      contactsFound: 0,
      evidenceCollected: 0,
      verifiedFields: 0,
      conflictsFound: 0,
      duplicatesFound: 0,
      qualifiedLeads: 0,
    });
    expect(masked.companiesDiscovered).toBe(2);
    expect(masked.companiesProcessed).toBeNull();
    expect(masked.qualifiedLeads).toBeNull();
  });
});

function repositoryMock() {
  return {
    findActive: jest.fn().mockResolvedValue(null),
    findLatest: jest.fn(),
    findById: jest.fn(),
    insert: jest.fn(),
    update: jest.fn(),
    findBySearchExecution: jest.fn(),
    counters: jest.fn().mockResolvedValue({
      companiesDiscovered: 0,
      companiesProcessed: 0,
      websitesResearched: 0,
      decisionMakersFound: 0,
      contactsFound: 0,
      evidenceCollected: 0,
      verifiedFields: 0,
      conflictsFound: 0,
      duplicatesFound: 0,
      qualifiedLeads: 0,
    }),
    audit: jest.fn(),
  };
}

function logger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function config(values: Record<string, unknown>) {
  return { get: (key: string) => values[key] } as ConfigService;
}

function runnerWith(repository: Record<string, unknown>) {
  return new PipelineStageRunner(
    repository as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
}
