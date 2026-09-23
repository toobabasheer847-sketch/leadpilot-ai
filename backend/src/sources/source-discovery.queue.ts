import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';

export interface SourceDiscoveryJobData {
  searchExecutionId: string;
  searchConfigurationId: string;
  organizationId: string;
}

@Injectable()
export class SourceDiscoveryQueue {
  constructor(@InjectQueue('source-discovery-queue') private readonly queue: Queue) {}

  enqueue(data: SourceDiscoveryJobData): Promise<Job<SourceDiscoveryJobData>> {
    return this.queue.add('SEARCH_DISCOVERY', data, {
      jobId: `search-discovery-${data.searchExecutionId}`,
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: 100,
      removeOnFail: 100,
    });
  }
}
