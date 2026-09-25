import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import { Job, UnrecoverableError } from 'bullmq';
import { EnrichmentService } from './enrichment.service';
import { CompanyEnrichmentJobData } from './website/website.types';
import { DRIZZLE } from '../database/database.constants';
import type { Database } from '../database/database.types';
import { and, eq } from 'drizzle-orm';
import { pipelineJobs } from '../database/schema/schema';
import { StructuredLoggerService } from '../common/observability/structured-logger.service';
import { isWebsiteDiscoveryError, websiteFailureLog } from './website/website-discovery.error';
import { isWebSearchError } from './website/web-search.error';

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
    const bullJobId = job.id ? String(job.id) : undefined;
    if (searchExecutionId) await this.updatePipelineJob(searchExecutionId, 'RUNNING', bullJobId);
    this.logger.info('job.company_enrichment.started', { jobId: job.id, companyId: job.data.companyId });
    try {
      const result = await this.enrichmentService.runCompanyEnrichment(job.data);
      if (searchExecutionId) await this.updatePipelineJob(searchExecutionId, 'COMPLETED', bullJobId);
      return result;
    } catch (error) {
      const failure = websiteFailureLog(error);
      if (searchExecutionId) await this.updatePipelineJob(searchExecutionId, 'FAILED', bullJobId, failure.message);
      this.logger.warn('job.company_enrichment.failed', { jobId: job.id, companyId: job.data.companyId, stage: failure.stage, errorCode: failure.errorCode, provider: failure.provider, operation: failure.operation, retryable: failure.retryable, message: failure.message });
      if ((isWebsiteDiscoveryError(error) || isWebSearchError(error)) && !failure.retryable) {
        throw new UnrecoverableError(failure.message);
      }
      throw error;
    }
  }

  private updatePipelineJob(searchExecutionId: string, status: string, bullJobId?: string, errorMessage?: string) {
    return this.db.update(pipelineJobs).set({ status, ...(errorMessage ? { errorMessage } : {}), ...(status === 'COMPLETED' || status === 'FAILED' ? { completedAt: new Date() } : {}), updatedAt: new Date() }).where(and(eq(pipelineJobs.searchExecutionId, searchExecutionId), eq(pipelineJobs.jobType, 'COMPANY_ENRICHMENT'), ...(bullJobId ? [eq(pipelineJobs.bullJobId, bullJobId)] : [])));
  }
}
