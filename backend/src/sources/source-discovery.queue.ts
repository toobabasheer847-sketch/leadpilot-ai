import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { RequestContextService } from '../common/observability/request-context.service';

export interface SourceDiscoveryJobData {
  searchExecutionId: string;
  searchConfigurationId: string;
  organizationId: string;
}

@Injectable()
export class SourceDiscoveryQueue {
  constructor(@InjectQueue('source-discovery-queue') private readonly queue: Queue, private readonly context: RequestContextService) {}

  enqueue(data: SourceDiscoveryJobData): Promise<Job<SourceDiscoveryJobData>> {
    return this.queue.add('SEARCH_DISCOVERY', { ...data, correlationId: this.context.get()?.correlationId }, {
      jobId: `search-discovery-${data.searchExecutionId}`,
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: 100,
      removeOnFail: 100,
    });
  }
}
