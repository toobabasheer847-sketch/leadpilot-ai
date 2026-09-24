import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QueueEvents } from 'bullmq';
import { MetricsService } from '../common/observability/metrics.service';
import { StructuredLoggerService } from '../common/observability/structured-logger.service';

const QUEUES = [
  'lead-research-queue',
  'ai-classification-queue',
  'contact-discovery-queue',
  'lead-deduplication-queue',
  'company-enrichment-queue',
  'lead-export-queue',
  'lead-scoring-queue',
  'source-discovery-queue',
  'lead-verification-queue',
  'lead-qualification-queue',
  'lead-pipeline-queue',
  'contact-quality-queue',
];

@Injectable()
export class QueueObservabilityService implements OnModuleInit, OnModuleDestroy {
  private readonly events: QueueEvents[] = [];
  private readonly started = new Map<string, number>();

  constructor(
    private readonly config: ConfigService,
    private readonly metrics: MetricsService,
    private readonly logger: StructuredLoggerService,
  ) {}

  onModuleInit() {
    const redisUrl = this.config.get<string>('redis.url') ?? 'redis://localhost:6379';
    const parsed = new URL(redisUrl);
    for (const queue of QUEUES) {
      const events = new QueueEvents(queue, { connection: { host: parsed.hostname, port: Number(parsed.port || 6379), password: parsed.password || undefined } });
      events.on('waiting', ({ jobId }) => {
        this.metrics.increment('jobs_total', { queue, status: 'queued' });
        this.logger.info('job.queued', { queue, jobId });
      });
      events.on('active', ({ jobId }) => {
        this.started.set(`${queue}:${jobId}`, Date.now());
        this.metrics.increment('jobs_total', { queue, status: 'started' });
        this.logger.info('job.started', { queue, jobId });
      });
      events.on('completed', ({ jobId, prev }) => this.finish(queue, jobId, 'completed', prev));
      events.on('failed', ({ jobId, failedReason, prev }) => {
        this.metrics.increment('jobs_retried_total', { queue });
        this.finish(queue, jobId, 'failed', prev, { failureCategory: this.safeCategory(failedReason) });
      });
      events.on('retries-exhausted', ({ jobId }) => {
        this.logger.warn('job.retries.exhausted', { queue, jobId });
      });
      events.on('stalled', ({ jobId }) => {
        this.metrics.increment('jobs_total', { queue, status: 'stalled' });
        this.logger.warn('job.stalled', { queue, jobId });
      });
      events.on('delayed', ({ jobId }) => {
        this.metrics.increment('jobs_total', { queue, status: 'delayed' });
        this.logger.info('job.delayed', { queue, jobId });
      });
      events.on('error', () => this.logger.warn('queue.events.error', { queue }));
      this.events.push(events);
    }
  }

  async onModuleDestroy() {
    await Promise.all(this.events.map((events) => events.close()));
  }

  private finish(queue: string, jobId: string, status: 'completed' | 'failed', previous?: string, metadata: Record<string, unknown> = {}) {
    const key = `${queue}:${jobId}`;
    const startedAt = this.started.get(key);
    const durationMs = startedAt ? Date.now() - startedAt : undefined;
    this.started.delete(key);
    this.metrics.increment('jobs_total', { queue, status });
    if (status === 'failed') this.metrics.increment('jobs_failed_total', { queue });
    else this.metrics.increment('jobs_completed_total', { queue });
    if (durationMs !== undefined) this.metrics.observe('job_duration_ms', durationMs, { queue });
    this.logger[status === 'failed' ? 'error' : 'info'](`job.${status}`, { queue, jobId, previous, durationMs, ...metadata });
  }

  private safeCategory(reason: string | undefined) {
    if (!reason) return 'unknown';
    if (/timeout/i.test(reason)) return 'timeout';
    if (/redis/i.test(reason)) return 'redis';
    if (/provider|http/i.test(reason)) return 'provider';
    return 'worker';
  }
}