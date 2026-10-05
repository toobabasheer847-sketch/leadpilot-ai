import { Queue, QueueEvents, Worker } from 'bullmq';
import Redis from 'ioredis';
import { BULL_DEFAULT_JOB_OPTIONS, bullConnectionOptions, bullRedisClients, closeBullResources, LONG_RUNNING_WORKER } from './bull-connection';
import { isRedisOomError } from '../redis/redis-error';

const prefix = `leadpilot-test-${process.pid}`;

describe('bull connection', () => {
  jest.setTimeout(20_000);
  it('pins local redis to 127.0.0.1 and renews locks before they expire', () => {
    expect(bullConnectionOptions('redis://localhost:6379')).toMatchObject({ host: '127.0.0.1', port: 6379, maxRetriesPerRequest: null });
    expect(bullConnectionOptions('redis://127.0.0.1:6379').host).toBe('127.0.0.1');
    expect(LONG_RUNNING_WORKER.lockRenewTime).toBeLessThan(LONG_RUNNING_WORKER.lockDuration ?? 0);
    expect(BULL_DEFAULT_JOB_OPTIONS).toEqual({ removeOnComplete: 50, removeOnFail: 100 });
    expect(isRedisOomError(new Error("OOM command not allowed when used memory > 'maxmemory'."))).toBe(true);
    expect(isRedisOomError({ code: 'OOM' })).toBe(true);
    expect(isRedisOomError(new Error('WRONGTYPE operation against a key'))).toBe(false);
  });

  it('surfaces a failed redis connection and still closes', async () => {
    const queue = new Queue('failed-redis', {
      prefix,
      connection: {
        host: '127.0.0.1',
        port: 1,
        maxRetriesPerRequest: 1,
        connectTimeout: 400,
        retryStrategy: () => null,
      },
    });
    await expect(queue.waitUntilReady()).rejects.toThrow();
    const errors = await closeBullResources([queue], 3_000);
    expect(errors.length).toBeGreaterThanOrEqual(0);
  });

  it('reconnects after the client is disconnected', async () => {
    const client = new Redis({ ...bullConnectionOptions('redis://127.0.0.1:6379'), lazyConnect: true, maxRetriesPerRequest: 1 });
    client.on('error', () => undefined);
    await client.connect();
    expect(await client.ping()).toBe('PONG');
    client.disconnect();
    await expect(client.ping()).rejects.toThrow();
    await client.connect();
    expect(await client.ping()).toBe('PONG');
    client.disconnect();
  });

  it('starts a queue and worker, renews a long job lock, and shuts down', async () => {
    const connection = bullConnectionOptions('redis://127.0.0.1:6379');
    const name = 'lock-renewal';
    const queue = new Queue(name, { connection, prefix });
    const events = new QueueEvents(name, { connection, prefix });
    const renewed: string[] = [];
    const worker = new Worker(name, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_600));
      return 'done';
    }, {
      connection,
      prefix,
      concurrency: 1,
      lockDuration: 1_000,
      lockRenewTime: 300,
    });
    worker.on('locksRenewed', ({ jobIds }) => renewed.push(...jobIds));
    worker.on('error', () => undefined);
    await Promise.all([worker.waitUntilReady(), events.waitUntilReady()]);
    const job = await queue.add('probe', { ok: true }, { removeOnComplete: true, removeOnFail: true });
    await expect(job.waitUntilFinished(events, 8_000)).resolves.toBe('done');
    expect(renewed.length).toBeGreaterThan(0);
    const started = Date.now();
    const errors = await closeBullResources([worker, events, queue]);
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(errors).toEqual([]);
    const clients = [worker, events, queue].flatMap((resource) => bullRedisClients(resource));
    expect(clients.length).toBeGreaterThanOrEqual(4);
    await new Promise((resolve) => setTimeout(resolve, 400));
    for (const client of clients) expect(client.status).toBe('end');
  });

  it('prunes completed jobs using the configured default retention count', async () => {
    const connection = bullConnectionOptions('redis://127.0.0.1:6379');
    const name = 'job-retention';
    const queue = new Queue(name, { connection, prefix, defaultJobOptions: BULL_DEFAULT_JOB_OPTIONS });
    queue.setMaxListeners(BULL_DEFAULT_JOB_OPTIONS.removeOnComplete + 10);
    const events = new QueueEvents(name, { connection, prefix });
    const worker = new Worker(name, async (job) => job.data.value, { connection, prefix });
    worker.on('error', () => undefined);

    try {
      await Promise.all([queue.waitUntilReady(), events.waitUntilReady(), worker.waitUntilReady()]);
      await worker.pause();
      const jobCount = BULL_DEFAULT_JOB_OPTIONS.removeOnComplete + 1;
      const jobs = await Promise.all(Array.from({ length: jobCount }, (_, index) => queue.add('retention-probe', { value: index })));
      const completions = jobs.map((job) => job.waitUntilFinished(events, 15_000));
      await worker.resume();
      await Promise.all(completions);

      expect(await queue.getJob(String(jobs[0].id))).toBeUndefined();
      expect(await queue.getJob(String(jobs[jobCount - 1].id))).toBeDefined();
    } finally {
      await closeBullResources([worker, events, queue]);
    }
  });
});
