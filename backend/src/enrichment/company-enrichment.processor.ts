import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import { Job } from 'bullmq';
import { EnrichmentService } from './enrichment.service';
import { CompanyEnrichmentJobData } from './website/website.types';
import { DRIZZLE } from '../database/database.constants';
import type { Database } from '../database/database.types';
import { and, eq } from 'drizzle-orm';
import { pipelineJobs } from '../database/schema/schema';
import { StructuredLoggerService } from '../common/observability/structured-logger.service';

@Processor('company-enrichment-queue')
export class CompanyEnrichmentProcessor extends WorkerHost {
  constructor(
    @Inject(EnrichmentService) private readonly enrichmentService: EnrichmentService,
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly logger: StructuredLoggerService,
  ) {
    super();
  }

  async process(job: Job<CompanyEnrichmentJobData>) {
    const { searchExecutionId } = job.data;
    if (searchExecutionId) await this.updatePipelineJob(searchExecutionId, 'RUNNING');
    this.logger.info('job.company_enrichment.started', { jobId: job.id, companyId: job.data.companyId });
    try {
      const result = await this.enrichmentService.runCompanyEnrichment(job.data);
      if (searchExecutionId) await this.updatePipelineJob(searchExecutionId, 'COMPLETED');
      return result;
    } catch (error) {
      if (searchExecutionId) await this.updatePipelineJob(searchExecutionId, 'FAILED', error instanceof Error ? error.name : 'Enrichment failed');
      this.logger.warn('job.company_enrichment.failed', { jobId: job.id, companyId: job.data.companyId, errorType: error instanceof Error ? error.name : 'unknown' });
      throw error;
    }
  }

  private updatePipelineJob(searchExecutionId: string, status: string, errorMessage?: string) {
    return this.db.update(pipelineJobs).set({ status, ...(errorMessage ? { errorMessage } : {}), ...(status === 'COMPLETED' || status === 'FAILED' ? { completedAt: new Date() } : {}), updatedAt: new Date() }).where(and(eq(pipelineJobs.searchExecutionId, searchExecutionId), eq(pipelineJobs.jobType, 'COMPANY_ENRICHMENT')));
  }
}
