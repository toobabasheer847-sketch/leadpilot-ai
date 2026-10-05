import { BeforeApplicationShutdown, Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { DiscoveryService, ModuleRef } from '@nestjs/core';
import { getQueueToken } from '@nestjs/bullmq';
import { WorkerHost } from '@nestjs/bullmq';
import type { Queue, Worker } from 'bullmq';
import { StructuredLoggerService } from '../common/observability/structured-logger.service';
import { DatabaseService } from '../database/database.service';
import { RedisService } from '../redis/redis.service';
import { isRedisOomError } from '../redis/redis-error';
import { bullRedisClients, BullResource, closeBullResources, countRedisClients, enterRedisShutdown, isRedisShutdown, isShutdownConnectionError, leaveRedisShutdown, noteShutdownReset, takeShutdownResetCount } from './bull-connection';
import { QUEUE_NAMES, QueueObservabilityService } from './queue-observability.service';

@Injectable()
export class QueueShutdownService implements OnApplicationBootstrap, OnModuleDestroy, BeforeApplicationShutdown {
  private readonly sinksAttached = new WeakSet<object>();
  private shutdownPromise?: Promise<void>;

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly moduleRef: ModuleRef,
    private readonly events: QueueObservabilityService,
    private readonly redis: RedisService,
    private readonly database: DatabaseService,
    private readonly logger: StructuredLoggerService,
  ) {}

  onApplicationBootstrap() {
    const workers = this.workers();
    const queues = this.queues();
    const queueEvents = this.events.queueEvents();
    this.attachRuntimeErrorSinks([...workers, ...queues, ...queueEvents]);
    const names = workers.map((worker) => worker.name);
    const duplicates = [...new Set(names.filter((name, index) => names.indexOf(name) !== index))];
    const census = countRedisClients([...workers, ...queues, ...queueEvents], [{ status: this.redis.connectionClient().status }]);
    if (duplicates.length > 0) {
      this.logger.error('redis.duplicate_worker', { queues: duplicates });
    }
    this.logger.info('redis.connections.started', {
      queues: queues.length,
      workers: workers.length,
      queueEvents: queueEvents.length,
      redisService: 1,
      inspectorClients: 0,
      openClients: census.open,
      trackedClients: census.clients,
    });
  }

  onModuleDestroy() {
    return this.shutdown('destroy');
  }

  beforeApplicationShutdown(signal?: string) {
    return this.shutdown(signal ?? 'shutdown');
  }

  private shutdown(signal: string) {
    this.shutdownPromise ??= this.runShutdown(signal);
    return this.shutdownPromise;
  }

  private async runShutdown(signal: string) {
    const workers = this.workers();
    await Promise.all(workers.map(async (worker) => {
      try {
        await worker.pause(true);
      } catch (error) {
        if (!isShutdownConnectionError(error)) {
          this.logger.error('redis.worker.pause_failed', { message: error instanceof Error ? error.message : 'Worker pause failed' });
        }
      }
    }));
    const queues = this.queues();
    const queueEvents = this.events.queueEvents();
    const resources: BullResource[] = [...workers, ...queueEvents, ...queues];
    enterRedisShutdown();
    try {
      const before = countRedisClients(resources, [{ status: this.redis.connectionClient().status }]);
      this.logger.info('redis.connections.closing', {
        signal: signal ?? 'close',
        queues: queues.length,
        workers: workers.length,
        queueEvents: queueEvents.length,
        openClients: before.open,
        trackedClients: before.clients,
      });
      const errors = await closeBullResources(resources);
      await this.redis.closeClient();
      await this.database.closePool();
      await new Promise((resolve) => setImmediate(resolve));
      const after = countRedisClients(resources, [{ status: this.redis.connectionClient().status }]);
      const shutdownResets = takeShutdownResetCount();
      this.logger.info('redis.connections.closed', {
        signal: signal ?? 'close',
        openClients: after.open,
        trackedClients: after.clients,
        shutdownResets,
        errors: errors.length,
      });
      for (const error of errors) {
        this.logger.error('redis.shutdown.failed', { signal: signal ?? 'close', message: error.message });
      }
    } finally {
      leaveRedisShutdown();
    }
  }

  private workers(): Worker[] {
    return this.discovery.getProviders().flatMap((wrapper) => {
      const instance = wrapper.instance;
      if (!(instance instanceof WorkerHost)) return [];
      const worker = (instance as unknown as { _worker?: Worker })._worker;
      return worker ? [worker] : [];
    });
  }

  private queues(): Queue[] {
    const found: Queue[] = [];
    for (const name of QUEUE_NAMES) {
      try {
        found.push(this.moduleRef.get<Queue>(getQueueToken(name), { strict: false }));
      } catch (error) {
        this.logger.error('redis.queue.missing', {
          queue: name,
          message: error instanceof Error ? error.message : 'Queue is not registered',
        });
      }
    }
    return found;
  }

  private attachRuntimeErrorSinks(resources: BullResource[]) {
    for (const resource of resources) {
      if (!resource.on || this.sinksAttached.has(resource)) continue;
      if ((resource.listenerCount?.('error') ?? 0) > 0) {
        this.sinksAttached.add(resource);
        continue;
      }
      this.sinksAttached.add(resource);
      resource.on('error', (error: Error) => {
        if (isRedisShutdown() && isShutdownConnectionError(error)) {
          noteShutdownReset();
          return;
        }
        const clients = bullRedisClients(resource);
        if (isRedisOomError(error)) {
          this.logger.warn('redis.client.oom', {
            code: 'OOM',
            openClients: clients.filter((client) => client.status && client.status !== 'end').length,
          });
          return;
        }
        const code = 'code' in error && typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : '';
        this.logger.error('redis.client.error', {
          message: error.message,
          code,
          openClients: clients.filter((client) => client.status && client.status !== 'end').length,
        });
      });
    }
  }
}
