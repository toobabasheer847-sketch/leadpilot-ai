import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { ScoringService } from './scoring.service';
import type { ScoringJobData } from './types/scoring.types';

@Processor('lead-scoring-queue', { lockDuration: 180_000, lockRenewTime: 15_000, stalledInterval: 30_000, maxStalledCount: 2 })
export class ScoringProcessor extends WorkerHost {
  constructor(private readonly service: ScoringService) { super(); }

  process(job: Job<ScoringJobData>) {
    return this.service.scoreQueued(job.data);
  }
}
