import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import { Job } from 'bullmq';
import { ContactsService } from './contacts.service';
import { ContactDiscoveryJobData } from './contact-discovery.queue';
import { DRIZZLE } from '../database/database.constants';
import type { Database } from '../database/database.types';
import { and, eq } from 'drizzle-orm';
import { pipelineJobs } from '../database/schema/schema';
import { StructuredLoggerService } from '../common/observability/structured-logger.service';

@Processor('contact-discovery-queue')
export class ContactDiscoveryProcessor extends WorkerHost {
  constructor(
    private readonly contactsService: ContactsService,
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly logger: StructuredLoggerService,
  ) {
    super();
  }

  async process(job: Job<ContactDiscoveryJobData>) {
    if (job.data.searchExecutionId) await this.updateJob(job.data.searchExecutionId, 'RUNNING');
    this.logger.info('job.contact_discovery.started', { jobId: job.id, companyId: job.data.companyId });
    try {
      const result = await this.contactsService.discoverForCompany(job.data.companyId, job.data.organizationId, job.data.searchExecutionId ?? null, job.data.correlationId);
      if (job.data.searchExecutionId) await this.updateJob(job.data.searchExecutionId, 'COMPLETED');
      return result;
    } catch (error) {
      if (job.data.searchExecutionId) await this.updateJob(job.data.searchExecutionId, 'FAILED', error instanceof Error ? error.name : 'Contact discovery failed');
      this.logger.warn('job.contact_discovery.failed', { jobId: job.id, companyId: job.data.companyId, errorType: error instanceof Error ? error.name : 'unknown' });
      throw error;
    }
  }

  private updateJob(searchExecutionId: string, status: string, errorMessage?: string) {
    return this.db.update(pipelineJobs).set({ status, ...(errorMessage ? { errorMessage } : {}), ...(status === 'COMPLETED' || status === 'FAILED' ? { completedAt: new Date() } : {}), updatedAt: new Date() }).where(and(eq(pipelineJobs.searchExecutionId, searchExecutionId), eq(pipelineJobs.jobType, 'CONTACT_DISCOVERY')));
  }
}
