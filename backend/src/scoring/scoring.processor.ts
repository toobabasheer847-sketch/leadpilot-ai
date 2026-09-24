import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { ScoringService } from './scoring.service';
import type { ScoringJobData } from './types/scoring.types';

@Processor('lead-scoring-queue')
export class ScoringProcessor extends WorkerHost {
  constructor(private readonly service: ScoringService) { super(); }

  process(job: Job<ScoringJobData>) {
    return this.service.scoreQueued(job.data);
  }
}
