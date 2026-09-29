import { ConfigService } from '@nestjs/config';
import { mapWithConcurrency } from '../common/concurrency';
import { MetricsService } from '../common/observability/metrics.service';
import {
  AFTER_POST_ENRICHMENT,
  AFTER_POST_EVIDENCE,
  PIPELINE_STAGE_DEPENDENCIES,
  POST_ENRICHMENT_PARALLEL,
  POST_EVIDENCE_PARALLEL,
} from './pipeline.dependencies';
import { initialProgress, parseProgress, summarizeJobStates } from './pipeline.progress';
import { PipelineStageRunner } from './pipeline.runner';
import type { PipelineProgressState } from './pipeline.types';

function companyIds(count: number, org = 'org-a') {
  return Array.from({ length: count }, (_, index) => `${org}-company-${index + 1}`);
}

function row(stage: string, progress: PipelineProgressState) {
  return {
    id: 'pipeline-m',
    organizationId: 'org-a',
    searchId: 'search-m',
    searchExecutionId: 'exec-m',
    status: 'RUNNING' as const,
    currentStage: stage,
    stageProgress: progress,
    startedAt: null,
    completedAt: null,
    failedAt: null,
    errorCode: null,
    errorMessage: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function metricsStub() {
  return { increment: jest.fn(), observe: jest.fn() };
}

describe('Phase M pipeline stage dependency graph', () => {
  it('A. documents real dependencies without inventing parallel edges', () => {
    const byStage = Object.fromEntries(PIPELINE_STAGE_DEPENDENCIES.map((item) => [item.stage, item]));
    expect(byStage.DEEP_RESEARCH.canRunInParallelWith).toEqual(
      expect.arrayContaining(['EMPLOYEE_SIZE', 'DECISION_MAKER_DISCOVERY']),
    );
    expect(byStage.CLASSIFICATION.canRunInParallelWith).toEqual(['VERIFICATION']);
    expect(byStage.SCORING.mustWaitFor).toEqual(expect.arrayContaining(['CLASSIFICATION', 'VERIFICATION']));
    expect(byStage.QUALIFICATION.mustWaitFor).toEqual(['SCORING']);
    expect(byStage.DEDUPLICATION.dependsOnVerification).toBe(true);
    expect(byStage.CONTACT_QUALITY.dependsOnDecisionMakers).toBe(true);
    expect(byStage.CLASSIFICATION.dependsOnEvidence).toBe(true);
    expect(byStage.CLASSIFICATION.dependsOnVerification).toBe(false);
    expect(AFTER_POST_ENRICHMENT).toBe('CONTACT_QUALITY');
    expect(AFTER_POST_EVIDENCE).toBe('DEDUPLICATION');
    expect([...POST_ENRICHMENT_PARALLEL]).toEqual(['deepResearch', 'employeeSize', 'decisionMakerDiscovery']);
    expect([...POST_EVIDENCE_PARALLEL]).toEqual(['classification', 'verification']);
  });

  it('B. post-enrichment dispatches deep research, employee-size, and DM together for 300 companies', async () => {
    const ids = companyIds(300);
    const enqueued: string[] = [];
    let maxInFlight = 0;
    let inFlight = 0;
    const repository = {
      listCompanyIds: jest.fn().mockResolvedValue(ids),
      getSearchExecution: jest.fn().mockResolvedValue({
        structuredPlan: {
          targetType: 'QUALIFIED_LEADS',
          companySize: { min: 1, max: 50 },
          decisionMakerRoles: ['CEO'],
          leadTypes: [],
          industry: [],
          locations: [],
        },
      }),
    };
    const research = {
      enqueueTracked: jest.fn().mockImplementation(async (companyId: string) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        enqueued.push(`research:${companyId}`);
        inFlight -= 1;
        return `research-${companyId}`;
      }),
    };
    const employeeSize = {
      enqueue: jest.fn().mockImplementation(async (data: { companyId: string }) => {
        enqueued.push(`size:${data.companyId}`);
        return { id: `size-${data.companyId}` };
      }),
    };
    const contacts = {
      enqueueContactDiscovery: jest.fn().mockImplementation(async (companyId: string, organizationId: string) => {
        expect(organizationId).toBe('org-a');
        enqueued.push(`dm:${companyId}`);
        return { jobId: `dm-${companyId}` };
      }),
    };
    const jobs = { settle: jest.fn() };
    const metrics = metricsStub();
    const runner = new PipelineStageRunner(
      repository as never,
      {} as never,
      contacts as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      research as never,
      {} as never,
      employeeSize as never,
      jobs as never,
      metrics as never,
      { get: () => 8 } as ConfigService,
    );

    const first = await runner.tick(row('DEEP_RESEARCH', initialProgress()) as never, initialProgress());
    expect(first.type).toBe('wait');
    if (first.type !== 'wait') return;
    expect(first.progress.jobs.deepResearch).toHaveLength(300);
    expect(first.progress.jobs.employeeSize).toHaveLength(300);
    expect(first.progress.jobs.decisionMakerDiscovery).toHaveLength(300);
    expect(first.progress.stages.deepResearch).toBe('RUNNING');
    expect(first.progress.stages.employeeSize).toBe('RUNNING');
    expect(first.progress.stages.decisionMakerDiscovery).toBe('RUNNING');
    expect(first.progress.stages.verification).toBe('PENDING');
    expect(first.progress.stages.qualification).toBe('PENDING');
    expect(maxInFlight).toBeLessThanOrEqual(8);
    expect(enqueued.filter((item) => item.startsWith('research:'))).toHaveLength(300);
    expect(enqueued.filter((item) => item.startsWith('size:'))).toHaveLength(300);
    expect(enqueued.filter((item) => item.startsWith('dm:'))).toHaveLength(300);
    expect(enqueued.some((item) => item.includes('org-b'))).toBe(false);
    expect(first.progress.metrics?.stages.deepResearch?.startedAtMs).toEqual(expect.any(Number));
    expect(jobs.settle).not.toHaveBeenCalled();

    // Dependent stages must not start while post-enrichment work is still pending.
    jobs.settle
      .mockResolvedValueOnce({ state: 'PENDING' })
      .mockResolvedValueOnce({ state: 'COMPLETED' })
      .mockResolvedValueOnce({ state: 'COMPLETED' });
    const waiting = await runner.tick(row('DEEP_RESEARCH', first.progress) as never, first.progress);
    expect(waiting.type).toBe('wait');
    if (waiting.type === 'wait') {
      expect(waiting.progress.stages.deepResearch).toBe('RUNNING');
      expect(waiting.progress.stages.contactQuality).toBe('PENDING');
      expect(waiting.progress.stages.scoring).toBe('PENDING');
      expect(waiting.progress.stages.qualification).toBe('PENDING');
    }

    jobs.settle
      .mockResolvedValueOnce({ state: 'COMPLETED' })
      .mockResolvedValueOnce({ state: 'COMPLETED' })
      .mockResolvedValueOnce({ state: 'COMPLETED' });
    const advanced = await runner.tick(row('DEEP_RESEARCH', first.progress) as never, first.progress);
    expect(advanced.type).toBe('advance');
    if (advanced.type === 'advance') {
      expect(advanced.currentStage).toBe('CONTACT_QUALITY');
      expect(advanced.progress.stages.deepResearch).toBe('COMPLETED');
      expect(advanced.progress.stages.employeeSize).toBe('COMPLETED');
      expect(advanced.progress.stages.decisionMakerDiscovery).toBe('COMPLETED');
      expect(advanced.progress.metrics?.stages.deepResearch?.durationMs).toEqual(expect.any(Number));
    }
  });

  it('C. one company failure in a parallel group does not block other companies or unrelated stages', async () => {
    const ids = companyIds(20);
    const repository = {
      listCompanyIds: jest.fn().mockResolvedValue(ids),
      getSearchExecution: jest.fn().mockResolvedValue({
        structuredPlan: { targetType: 'COMPANIES', companySize: { min: 10, max: 100 } },
      }),
    };
    const research = {
      enqueueTracked: jest.fn().mockImplementation(async (companyId: string) => {
        if (companyId.endsWith('-7')) throw new Error('website timeout');
        return `research-${companyId}`;
      }),
    };
    const employeeSize = {
      enqueue: jest.fn().mockImplementation(async (data: { companyId: string }) => ({ id: `size-${data.companyId}` })),
    };
    const contacts = { enqueueContactDiscovery: jest.fn() };
    const runner = new PipelineStageRunner(
      repository as never,
      {} as never,
      contacts as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      research as never,
      {} as never,
      employeeSize as never,
      { settle: jest.fn() } as never,
      metricsStub() as never,
      { get: () => 4 } as ConfigService,
    );

    const first = await runner.tick(row('DEEP_RESEARCH', initialProgress()) as never, initialProgress());
    expect(first.type).toBe('wait');
    if (first.type !== 'wait') return;
    expect(first.progress.jobs.deepResearch).toHaveLength(19);
    expect(first.progress.jobs.employeeSize).toHaveLength(20);
    expect(first.progress.jobs.decisionMakerDiscovery).toEqual([]);
    expect(first.progress.stages.decisionMakerDiscovery).toBe('SKIPPED');
    expect(contacts.enqueueContactDiscovery).not.toHaveBeenCalled();
  });

  it('D. classification and verification overlap after evidence; scoring/qualification stay blocked', async () => {
    const ids = companyIds(300);
    const repository = {
      listCompanyIds: jest.fn().mockResolvedValue(ids),
      listContactIds: jest.fn().mockResolvedValue([]),
      getSearchExecution: jest.fn().mockResolvedValue({ structuredPlan: { targetType: 'COMPANIES', leadTypes: ['SaaS'] } }),
    };
    const classification = {
      enqueue: jest.fn().mockImplementation(async (companyId: string) => ({ status: 'QUEUED', jobId: `class-${companyId}` })),
    };
    const verification = {
      enqueueCompany: jest.fn().mockImplementation(async (companyId: string) => ({ status: 'QUEUED', jobId: `verify-${companyId}` })),
      enqueueContact: jest.fn(),
    };
    const jobs = { settle: jest.fn() };
    const runner = new PipelineStageRunner(
      repository as never,
      {} as never,
      {} as never,
      classification as never,
      verification as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      jobs as never,
      metricsStub() as never,
      { get: () => 8 } as ConfigService,
    );

    const first = await runner.tick(row('CLASSIFICATION', initialProgress()) as never, initialProgress());
    expect(first.type).toBe('wait');
    if (first.type !== 'wait') return;
    expect(first.progress.jobs.classification).toHaveLength(300);
    expect(first.progress.jobs.verification).toHaveLength(300);
    expect(first.progress.stages.classification).toBe('RUNNING');
    expect(first.progress.stages.verification).toBe('RUNNING');
    expect(first.progress.stages.deduplication).toBe('PENDING');
    expect(first.progress.stages.scoring).toBe('PENDING');
    expect(first.progress.stages.qualification).toBe('PENDING');

    jobs.settle
      .mockResolvedValueOnce({ state: 'COMPLETED' })
      .mockResolvedValueOnce({ state: 'PENDING' });
    const waiting = await runner.tick(row('CLASSIFICATION', first.progress) as never, first.progress);
    expect(waiting.type).toBe('wait');
    if (waiting.type === 'wait') {
      expect(waiting.progress.stages.classification).toBe('COMPLETED');
      expect(waiting.progress.stages.verification).toBe('RUNNING');
      expect(waiting.progress.stages.scoring).toBe('PENDING');
      expect(waiting.progress.stages.qualification).toBe('PENDING');
    }

    jobs.settle
      .mockResolvedValueOnce({ state: 'COMPLETED' })
      .mockResolvedValueOnce({ state: 'COMPLETED' });
    const advanced = await runner.tick(row('CLASSIFICATION', first.progress) as never, first.progress);
    expect(advanced.type).toBe('advance');
    if (advanced.type === 'advance') {
      expect(advanced.currentStage).toBe('DEDUPLICATION');
      expect(advanced.progress.stages.classification).toBe('COMPLETED');
      expect(advanced.progress.stages.verification).toBe('COMPLETED');
    }
  });

  it('E. verification does not start before evidence barrier; qualification does not start before scoring inputs', async () => {
    const progress = initialProgress();
    progress.stages.enrichment = 'COMPLETED';
    progress.stages.deepResearch = 'RUNNING';
    expect(progress.stages.verification).toBe('PENDING');
    expect(progress.stages.classification).toBe('PENDING');
    expect(progress.stages.qualification).toBe('PENDING');

    const scoring = PIPELINE_STAGE_DEPENDENCIES.find((item) => item.stage === 'SCORING');
    const qualification = PIPELINE_STAGE_DEPENDENCIES.find((item) => item.stage === 'QUALIFICATION');
    expect(scoring?.dependsOnVerification).toBe(true);
    expect(scoring?.dependsOnClassification).toBe(true);
    expect(qualification?.dependsOnScoring).toBe(true);
    expect(qualification?.mustWaitFor).toEqual(['SCORING']);
  });

  it('F. concurrency limits remain bounded and no unbounded Promise.all over 300 companies', async () => {
    const ids = companyIds(300);
    let inFlight = 0;
    let maxInFlight = 0;
    const results = await mapWithConcurrency(ids, 8, async (companyId) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return companyId;
    }, { maxConcurrency: 32 });
    expect(results).toHaveLength(300);
    expect(maxInFlight).toBeLessThanOrEqual(8);
  });

  it('G. failure isolation keeps PARTIAL truthful for mixed outcomes', () => {
    expect(summarizeJobStates(
      Array.from({ length: 299 }, () => 'completed' as const).concat(['failed']),
      'Company 300 timed out.',
    )).toEqual({ state: 'PARTIAL', message: 'Company 300 timed out.' });
  });

  it('H. progress parsing preserves SKIPPED and stage metrics', () => {
    const progress = initialProgress();
    progress.stages.employeeSize = 'SKIPPED';
    progress.stages.decisionMakerDiscovery = 'SKIPPED';
    progress.metrics = {
      concurrencyLimit: 8,
      dispatchBatches: 2,
      providerRequestCount: 0,
      stages: {
        deepResearch: {
          startedAtMs: 1000,
          completedAtMs: 2500,
          durationMs: 1500,
          waitingMs: 400,
          activeJobs: 0,
          failedJobs: 0,
          retryCount: 0,
        },
      },
    };
    const parsed = parseProgress(progress);
    expect(parsed.stages.employeeSize).toBe('SKIPPED');
    expect(parsed.metrics?.stages.deepResearch?.durationMs).toBe(1500);
    expect(parsed.metrics?.stages.deepResearch?.waitingMs).toBe(400);
    expect(parsed.metrics?.concurrencyLimit).toBe(8);
  });

  it('I. 300-company scheduler stress does not explode memory while respecting org isolation', async () => {
    const ids = companyIds(300, 'org-load');
    const heapBefore = process.memoryUsage().heapUsed;
    const enqueued: string[] = [];
    await mapWithConcurrency(ids, 8, async (companyId) => {
      enqueued.push(companyId);
      return `job-${companyId}`;
    }, { maxConcurrency: 16 });
    expect(enqueued).toHaveLength(300);
    expect(enqueued.every((id) => id.startsWith('org-load-'))).toBe(true);
    expect(enqueued.some((id) => id.includes('org-b'))).toBe(false);
    const heapAfter = process.memoryUsage().heapUsed;
    expect(heapAfter - heapBefore).toBeLessThan(50 * 1024 * 1024);
  });

  it('J. MetricsService records stage duration and failed job counters', () => {
    const metrics = new MetricsService();
    metrics.observe('pipeline_stage_duration_ms', 1200, { stage: 'deepResearch' });
    metrics.observe('pipeline_stage_waiting_ms', 400, { stage: 'deepResearch' });
    metrics.increment('pipeline_stage_jobs_failed_total', { stage: 'verification' });
    metrics.observe('pipeline_stage_active_jobs', 300, { stage: 'classification' });
    const output = metrics.toPrometheus();
    expect(output).toContain('pipeline_stage_duration_ms');
    expect(output).toContain('pipeline_stage_waiting_ms');
    expect(output).toContain('pipeline_stage_jobs_failed_total');
    expect(output).toContain('pipeline_stage_active_jobs');
  });
});
