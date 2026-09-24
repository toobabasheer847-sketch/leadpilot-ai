import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { VerificationService } from './verification.service';
import type { VerificationJobData } from './types/verification.types';
import { StructuredLoggerService } from '../common/observability/structured-logger.service';

@Processor('lead-verification-queue')
export class VerificationProcessor extends WorkerHost {
  constructor(private readonly service: VerificationService, private readonly logger: StructuredLoggerService) { super(); }

  process(job: Job<VerificationJobData>) {
    this.logger.info('job.multi_source_verification.started', { jobId: job.id, companyId: job.data.companyId, contactId: job.data.contactId });
    return this.service.verifyQueued(job.data).catch((error: unknown) => {
      this.logger.warn('job.multi_source_verification.failed', { jobId: job.id, companyId: job.data.companyId, errorType: error instanceof Error ? error.name : 'unknown' });
      throw error;
    });
  }
}
