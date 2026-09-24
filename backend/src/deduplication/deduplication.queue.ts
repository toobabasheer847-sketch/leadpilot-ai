import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Job, Queue } from 'bullmq';

export interface DeduplicationJobData {
  entityType: 'COMPANY' | 'CONTACT';
  entityId: string;
  organizationId: string;
}

@Injectable()
export class DeduplicationQueue {
  constructor(@InjectQueue('lead-deduplication-queue') private readonly queue: Queue) {}

  enqueue(data: DeduplicationJobData): Promise<Job<DeduplicationJobData>> {
    return this.queue.add('LEAD_DEDUPLICATION', data, {
      jobId: `${data.organizationId}:${data.entityType}:${data.entityId}`,
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: true,
      removeOnFail: false,
    });
  }
}
