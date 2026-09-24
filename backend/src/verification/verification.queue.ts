import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import type { VerificationJobData } from './types/verification.types';

@Injectable()
export class VerificationQueue {
  constructor(@InjectQueue('lead-verification-queue') private readonly queue: Queue) {}

  enqueue(data: VerificationJobData): Promise<Job<VerificationJobData>> {
    return this.queue.add('LEAD_VERIFICATION', data, {
      jobId: data.idempotencyKey,
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: true,
      removeOnFail: false,
    });
  }
}
