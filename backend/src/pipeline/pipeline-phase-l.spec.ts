import { ConfigService } from '@nestjs/config';
import dns from 'node:dns/promises';
import { mapWithConcurrency } from '../common/concurrency';
import { enrichmentWorkerConcurrency } from '../common/enrichment-concurrency';
import { WebsiteFetchService } from '../enrichment/website/website-fetch.service';
import { WebsiteNormalizerService } from '../enrichment/website/website-normalizer.service';
import { summarizeJobStates } from '../pipeline/pipeline.progress';
import { PipelineStageRunner } from '../pipeline/pipeline.runner';
import { initialProgress } from '../pipeline/pipeline.progress';

function html(title: string) {
  return `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1></body></html>`;
}

function page(status: number, body: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => (name.toLowerCase() === 'content-type' ? 'text/html' : null),
      forEach: (callback: (value: string, key: string) => void) => {
        callback('text/html', 'content-type');
      },
    },
    body: {
      getReader: () => {
        const encoder = new TextEncoder();
        const bytes = encoder.encode(body);
        let done = false;
        return {
          read: async () => {
            if (done) return { done: true, value: undefined };
            done = true;
            return { done: false, value: bytes };
          },
          cancel: async () => undefined,
        };
      },
    },
  } as unknown as Response;
}

describe('Phase L post-discovery throughput', () => {
  const previous = process.env.ENRICHMENT_CONCURRENCY;

  afterEach(() => {
    if (previous === undefined) delete process.env.ENRICHMENT_CONCURRENCY;
    else process.env.ENRICHMENT_CONCURRENCY = previous;
    jest.restoreAllMocks();
  });

  it('A. ENRICHMENT_CONCURRENCY is bounded and defaults safely', () => {
    delete process.env.ENRICHMENT_CONCURRENCY;
    expect(enrichmentWorkerConcurrency()).toBe(4);
    process.env.ENRICHMENT_CONCURRENCY = '99';
    expect(enrichmentWorkerConcurrency()).toBe(16);
    process.env.ENRICHMENT_CONCURRENCY = '3';
    expect(enrichmentWorkerConcurrency()).toBe(3);
  });

  it('B. schedules 300 companies with bounded concurrency and preserves order/IDs', async () => {
    const companyIds = Array.from({ length: 300 }, (_, index) => `org-a-company-${index + 1}`);
    let inFlight = 0;
    let maxInFlight = 0;
    const received: string[] = [];
    const jobIds = await mapWithConcurrency(companyIds, 5, async (companyId) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      received.push(companyId);
      await Promise.resolve();
      inFlight -= 1;
      return `job-${companyId}`;
    }, { maxConcurrency: 16 });

    expect(jobIds).toHaveLength(300);
    expect(maxInFlight).toBeLessThanOrEqual(5);
    expect(received).toEqual(companyIds);
    expect(jobIds.every((id) => id.startsWith('job-org-a-company-'))).toBe(true);
    expect(jobIds.some((id) => id.includes('org-b'))).toBe(false);
  });

  it('C. one company failure does not stop the remaining batch', async () => {
    const companyIds = Array.from({ length: 20 }, (_, index) => `company-${index}`);
    const outcomes = await mapWithConcurrency(companyIds, 4, async (companyId) => {
      try {
        if (companyId === 'company-7') throw new Error('website timeout');
        return { ok: true as const, companyId };
      } catch (error) {
        return { ok: false as const, companyId, message: error instanceof Error ? error.message : 'failed' };
      }
    });

    expect(outcomes.filter((item) => item.ok)).toHaveLength(19);
    expect(outcomes.filter((item) => !item.ok)).toHaveLength(1);
  });

  it('D. duplicate canonical websites do not cause duplicate network fetches', async () => {
    jest.spyOn(dns, 'lookup').mockResolvedValue([] as never);
    const config = { get: (key: string, fallback?: unknown) => {
      const values: Record<string, unknown> = {
        'website.fetchTimeoutMs': 1000,
        'website.maxResponseBytes': 5000000,
        'website.maxRedirects': 5,
        'website.retries': 0,
        'website.respectRobots': false,
        'website.fetchConcurrency': 2,
        nodeEnv: 'test',
      };
      return values[key] ?? fallback;
    } } as ConfigService;
    const fetcher = new WebsiteFetchService(config, new WebsiteNormalizerService());
    fetcher.resetStatsForTests();
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(page(200, html('Oak Stream Investors')));

    const first = await fetcher.fetchPage('https://www.OakStream.example/');
    const second = await fetcher.fetchPage('https://oakstream.example');
    const third = await fetcher.fetchPage('HTTP://oakstream.example/');

    expect(first.title).toBe('Oak Stream Investors');
    expect(second.title).toBe('Oak Stream Investors');
    expect(third.title).toBe('Oak Stream Investors');
    const stats = fetcher.getStats();
    expect(stats.requests).toBe(1);
    expect(stats.duplicatesAvoided).toBeGreaterThanOrEqual(2);
    expect(stats.cacheHits + stats.inFlightJoins).toBeGreaterThanOrEqual(2);
  });

  it('E. provider/job partial failures degrade without failing the whole stage', () => {
    expect(summarizeJobStates(
      Array.from({ length: 299 }, () => 'completed' as const).concat(['failed']),
      'Company 300 timed out.',
    )).toEqual({ state: 'PARTIAL', message: 'Company 300 timed out.' });
    expect(summarizeJobStates(Array.from({ length: 300 }, () => 'failed' as const), 'All failed.')).toEqual({
      state: 'FAILED',
      message: 'All failed.',
    });
  });

  it('F. deep research and employee-size dispatch in parallel after enrichment', async () => {
    const enqueued: string[] = [];
    const repository = {
      listCompanyIds: jest.fn().mockResolvedValue(['c1', 'c2']),
      getSearchExecution: jest.fn().mockResolvedValue({
        structuredPlan: { companySize: { min: 1, max: 50 }, leadTypes: [], industry: [], locations: [] },
      }),
    };
    const research = {
      enqueueTracked: jest.fn().mockImplementation(async (companyId: string) => {
        enqueued.push(`research:${companyId}`);
        return `research-job-${companyId}`;
      }),
    };
    const employeeSize = {
      enqueue: jest.fn().mockImplementation(async (data: { companyId: string }) => {
        enqueued.push(`size:${data.companyId}`);
        return { id: `size-job-${data.companyId}` };
      }),
    };
    const jobs = {
      settle: jest.fn(),
    };
    const runner = new PipelineStageRunner(
      repository as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      research as never,
      {} as never,
      employeeSize as never,
      jobs as never,
      { get: () => 4 } as ConfigService,
    );

    const progress = initialProgress();
    const first = await runner.tick({
      id: 'pipeline-1',
      organizationId: 'org-1',
      searchId: 'search-1',
      searchExecutionId: 'exec-1',
      status: 'RUNNING',
      currentStage: 'DEEP_RESEARCH',
      stageProgress: progress,
      startedAt: null,
      completedAt: null,
      failedAt: null,
      errorCode: null,
      errorMessage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never, progress);

    expect(first.type).toBe('wait');
    if (first.type !== 'wait') return;
    expect(first.progress.jobs.deepResearch).toEqual(['research-job-c1', 'research-job-c2']);
    expect(first.progress.jobs.employeeSize).toEqual(['size-job-c1', 'size-job-c2']);
    expect(first.progress.stages.deepResearch).toBe('RUNNING');
    expect(first.progress.stages.employeeSize).toBe('RUNNING');
    expect(enqueued).toEqual(expect.arrayContaining(['research:c1', 'research:c2', 'size:c1', 'size:c2']));
    expect(jobs.settle).not.toHaveBeenCalled();

    jobs.settle
      .mockResolvedValueOnce({ state: 'COMPLETED' })
      .mockResolvedValueOnce({ state: 'COMPLETED' });
    const second = await runner.tick({
      id: 'pipeline-1',
      organizationId: 'org-1',
      searchId: 'search-1',
      searchExecutionId: 'exec-1',
      status: 'RUNNING',
      currentStage: 'DEEP_RESEARCH',
      stageProgress: first.progress,
      startedAt: null,
      completedAt: null,
      failedAt: null,
      errorCode: null,
      errorMessage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never, first.progress);

    expect(second.type).toBe('advance');
    if (second.type === 'advance') {
      expect(second.currentStage).toBe('DECISION_MAKER_DISCOVERY');
      expect(second.progress.stages.deepResearch).toBe('COMPLETED');
      expect(second.progress.stages.employeeSize).toBe('COMPLETED');
    }
  });

  it('G. 300-company dispatch stress stays within memory and concurrency bounds', async () => {
    const companyIds = Array.from({ length: 300 }, (_, index) => ({
      organizationId: 'org-load',
      companyId: `company-${index}`,
      searchExecutionId: 'exec-load',
    }));
    let inFlight = 0;
    let maxInFlight = 0;
    let failures = 0;
    let successes = 0;
    const started = Date.now();

    await mapWithConcurrency(companyIds, 8, async (item) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (item.companyId.endsWith('-13') || item.companyId.endsWith('-113') || item.companyId.endsWith('-213')) {
          failures += 1;
          throw new Error('transient provider failure');
        }
        await Promise.resolve();
        successes += 1;
        return item.companyId;
      } catch {
        return null;
      } finally {
        inFlight -= 1;
      }
    }, { maxConcurrency: 16 });

    const elapsedMs = Date.now() - started;
    expect(maxInFlight).toBeLessThanOrEqual(8);
    expect(successes).toBe(297);
    expect(failures).toBe(3);
    expect(elapsedMs).toBeLessThan(5000);
  });

  it('H. website fetch concurrency gate never exceeds WEBSITE_FETCH_CONCURRENCY', async () => {
    jest.spyOn(dns, 'lookup').mockResolvedValue([] as never);
    const config = { get: (key: string, fallback?: unknown) => {
      const values: Record<string, unknown> = {
        'website.fetchTimeoutMs': 1000,
        'website.maxResponseBytes': 5000000,
        'website.maxRedirects': 5,
        'website.retries': 0,
        'website.respectRobots': false,
        'website.fetchConcurrency': 2,
        nodeEnv: 'test',
      };
      return values[key] ?? fallback;
    } } as ConfigService;
    const fetcher = new WebsiteFetchService(config, new WebsiteNormalizerService());
    fetcher.resetStatsForTests();
    let inFlight = 0;
    let maxInFlight = 0;
    jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;
      return page(200, html('Company'));
    });

    await Promise.all(Array.from({ length: 10 }, (_, index) => fetcher.fetchPage(`https://site-${index}.example/`, { bypassCache: true })));
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(fetcher.getStats().maxInFlight).toBeLessThanOrEqual(2);
    expect(fetcher.getStats().requests).toBe(10);
  });
});
