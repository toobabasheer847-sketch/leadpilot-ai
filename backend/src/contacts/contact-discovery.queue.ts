import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { RequestContextService } from '../common/observability/request-context.service';

export interface ContactDiscoveryJobData {
  companyId: string;
  organizationId: string;
  searchExecutionId?: string | null;
}

@Injectable()
export class ContactDiscoveryQueue {
  constructor(@InjectQueue('contact-discovery-queue') private readonly queue: Queue, private readonly context: RequestContextService) {}

  enqueue(data: ContactDiscoveryJobData): Promise<Job<ContactDiscoveryJobData>> {
    return this.queue.add('CONTACT_DISCOVERY', { ...data, correlationId: this.context.get()?.correlationId }, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: true,
      removeOnFail: false,
    });
  }
}
