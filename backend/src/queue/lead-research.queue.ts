import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { RequestContextService } from '../common/observability/request-context.service';

@Injectable()
export class LeadResearchQueue {
  constructor(
    @InjectQueue('lead-research-queue') private readonly queue: Queue,
    private readonly context: RequestContextService,
  ) {}

  enqueueSystemTest(jobKey: string, data: Record<string, unknown> = {}): Promise<Job> {
    return this.queue.add('system-test', { ...data, correlationId: this.context.get()?.correlationId }, {
      jobId: `system-test-${jobKey}`,
    });
  }
}
