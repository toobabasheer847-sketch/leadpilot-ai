import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { CompanyEnrichmentJobData } from './website/website.types';

@Injectable()
export class CompanyEnrichmentQueue {
  constructor(@InjectQueue('company-enrichment-queue') private readonly queue: Queue) {}

  enqueue(data: CompanyEnrichmentJobData): Promise<Job<CompanyEnrichmentJobData>> {
    return this.queue.add('COMPANY_ENRICHMENT', data, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: true,
      removeOnFail: false,
    });
  }
}
