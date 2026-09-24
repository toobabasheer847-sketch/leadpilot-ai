import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import type { ScoringJobData } from './types/scoring.types';

@Injectable()
export class ScoringQueue {
  constructor(@InjectQueue('lead-scoring-queue') private readonly queue: Queue) {}

  enqueue(data: ScoringJobData): Promise<Job<ScoringJobData>> {
    return this.queue.add('LEAD_SCORING', data, {
      jobId: data.idempotencyKey,
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: true,
      removeOnFail: false,
    });
  }
}
