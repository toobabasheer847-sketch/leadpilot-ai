import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { DeduplicationService } from './deduplication.service';
import type { DeduplicationJobData } from './deduplication.queue';

@Processor('lead-deduplication-queue')
export class DeduplicationProcessor extends WorkerHost {
  constructor(private readonly service: DeduplicationService) { super(); }

  process(job: Job<DeduplicationJobData>) {
    return this.service.deduplicateQueued(job.data);
  }
}
