import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Job, Queue } from 'bullmq';

export interface ContactQualityJobData {
  organizationId: string;
  companyId: string;
  contactId: string;
}

@Injectable()
export class ContactQualityQueue {
  constructor(@InjectQueue('contact-quality-queue') private readonly queue: Queue) {}

  enqueue(data: ContactQualityJobData, jobId: string): Promise<Job<ContactQualityJobData>> {
    return this.queue.add('CONTACT_QUALITY_VERIFICATION', data, {
      jobId,
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: true,
      removeOnFail: false,
    });
  }
}
