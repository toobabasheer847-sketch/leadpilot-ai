import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import type { ClassificationCriteria } from './types/classification.types';
import { RequestContextService } from '../../common/observability/request-context.service';

export interface ClassificationJobData {
  companyId: string;
  searchExecutionId: string | null;
  organizationId: string;
  criteria: ClassificationCriteria;
  idempotencyKey: string;
}

@Injectable()
export class ClassificationQueue {
  constructor(@InjectQueue('ai-classification-queue') private readonly queue: Queue, private readonly context: RequestContextService) {}

  enqueue(data: ClassificationJobData): Promise<Job<ClassificationJobData>> {
    return this.queue.add('AI_CLASSIFICATION', { ...data, correlationId: this.context.get()?.correlationId }, {
      jobId: data.idempotencyKey,
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: true,
      removeOnFail: false,
    });
  }
}
