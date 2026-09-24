import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { QualificationService } from './qualification.service';
import type { QualificationJobData } from './types/qualification.types';
import { StructuredLoggerService } from '../common/observability/structured-logger.service';

@Processor('lead-qualification-queue')
export class QualificationProcessor extends WorkerHost {
  constructor(private readonly service: QualificationService, private readonly logger: StructuredLoggerService) { super(); }

  process(job: Job<QualificationJobData>) {
    this.logger.info('job.lead_qualification.started', { jobId: job.id, searchExecutionId: job.data.searchExecutionId });
    return this.service.qualifyQueued(job.data).catch((error: unknown) => {
      this.logger.warn('job.lead_qualification.failed', { jobId: job.id, searchExecutionId: job.data.searchExecutionId, errorType: error instanceof Error ? error.name : 'unknown' });
      throw error;
    });
  }
}
