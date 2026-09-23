import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';

@Injectable()
export class LeadResearchQueue {
  constructor(
    @InjectQueue('lead-research-queue') private readonly queue: Queue,
  ) {}

  enqueueSystemTest(jobKey: string, data: Record<string, unknown> = {}): Promise<Job> {
    return this.queue.add('system-test', data, {
      jobId: `system-test:${jobKey}`,
    });
  }
}
