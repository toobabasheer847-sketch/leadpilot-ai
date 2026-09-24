import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Job, Queue } from 'bullmq';

export interface ContactDiscoveryJobData {
  companyId: string;
  organizationId: string;
  searchExecutionId?: string | null;
}

@Injectable()
export class ContactDiscoveryQueue {
  constructor(@InjectQueue('contact-discovery-queue') private readonly queue: Queue) {}

  enqueue(data: ContactDiscoveryJobData): Promise<Job<ContactDiscoveryJobData>> {
    return this.queue.add('CONTACT_DISCOVERY', data, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: true,
      removeOnFail: false,
    });
  }
}
