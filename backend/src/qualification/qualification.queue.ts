import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import type { QualificationJobData } from './types/qualification.types';
import { RequestContextService } from '../common/observability/request-context.service';

@Injectable()
export class QualificationQueue {
  constructor(@InjectQueue('lead-qualification-queue') private readonly queue: Queue, private readonly context: RequestContextService) {}

  enqueue(data: QualificationJobData): Promise<Job<QualificationJobData>> {
    return this.queue.add('LEAD_QUALIFICATION', { ...data, correlationId: this.context.get()?.correlationId }, {
      jobId: data.idempotencyKey,
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: true,
      removeOnFail: false,
    });
  }
}
