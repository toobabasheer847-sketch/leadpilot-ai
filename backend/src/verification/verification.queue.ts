import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import type { VerificationJobData } from './types/verification.types';
import { RequestContextService } from '../common/observability/request-context.service';

@Injectable()
export class VerificationQueue {
  constructor(@InjectQueue('lead-verification-queue') private readonly queue: Queue, private readonly context: RequestContextService) {}

  enqueue(data: VerificationJobData): Promise<Job<VerificationJobData>> {
    return this.queue.add('MULTI_SOURCE_VERIFICATION', { ...data, correlationId: this.context.get()?.correlationId }, {
      jobId: data.idempotencyKey,
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: true,
      removeOnFail: false,
    });
  }
}
