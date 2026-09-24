import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Queue } from 'bullmq';

export interface DeepResearchJobData {
  organizationId: string;
  companyId: string;
  researchExecutionId: string;
}

@Injectable()
export class ResearchQueue {
  constructor(
    @InjectQueue('lead-research-queue') private readonly queue: Queue,
    private readonly config: ConfigService,
  ) {}

  enqueue(data: DeepResearchJobData, jobId: string): Promise<Job<DeepResearchJobData>> {
    const retries = this.config.get<number>('deepResearch.maxRetries', 2);
    return this.queue.add('DEEP_COMPANY_RESEARCH', data, {
      jobId,
      attempts: retries + 1,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: true,
      removeOnFail: false,
    });
  }
}
