import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { StructuredLoggerService } from '../../common/observability/structured-logger.service';
import { ContactQualityJobData } from './contact-quality.queue';
import { ContactQualityService } from './contact-quality.service';

@Processor('contact-quality-queue')
export class ContactQualityProcessor extends WorkerHost {
  constructor(
    private readonly quality: ContactQualityService,
    private readonly logger: StructuredLoggerService,
  ) {
    super();
  }

  async process(job: Job<ContactQualityJobData>) {
    this.logger.info('job.contact_quality.started', {
      jobId: job.id,
      organizationId: job.data.organizationId,
      companyId: job.data.companyId,
      contactId: job.data.contactId,
    });
    try {
      return await this.quality.verifyQueued(job.data);
    } catch (error) {
      this.logger.warn('job.contact_quality.failed', {
        jobId: job.id,
        organizationId: job.data.organizationId,
        companyId: job.data.companyId,
        contactId: job.data.contactId,
        errorType: error instanceof Error ? error.name : 'unknown',
      });
      throw error;
    }
  }
}
