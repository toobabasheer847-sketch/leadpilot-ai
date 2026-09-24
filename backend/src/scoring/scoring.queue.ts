import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import type { ScoringJobData } from './types/scoring.types';
import { RequestContextService } from '../common/observability/request-context.service';

@Injectable()
export class ScoringQueue {
  constructor(@InjectQueue('lead-scoring-queue') private readonly queue: Queue, private readonly context: RequestContextService) {}

  enqueue(data: ScoringJobData): Promise<Job<ScoringJobData>> {
    return this.queue.add('LEAD_SCORING', { ...data, correlationId: this.context.get()?.correlationId }, {
      jobId: data.idempotencyKey,
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: true,
      removeOnFail: false,
    });
  }
}
