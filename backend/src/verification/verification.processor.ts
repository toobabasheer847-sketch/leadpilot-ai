import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { VerificationService } from './verification.service';
import type { VerificationJobData } from './types/verification.types';

@Processor('lead-verification-queue')
export class VerificationProcessor extends WorkerHost {
  constructor(private readonly service: VerificationService) { super(); }

  process(job: Job<VerificationJobData>) {
    return this.service.verifyQueued(job.data);
  }
}
