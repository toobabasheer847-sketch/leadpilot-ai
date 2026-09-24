import { Processor, WorkerHost } from '@nestjs/bullmq';
import { NotFoundException } from '@nestjs/common';
import { Job, UnrecoverableError } from 'bullmq';
import { StructuredLoggerService } from '../common/observability/structured-logger.service';
import { DeepResearchJobData } from './research.queue';
import { ResearchService } from './research.service';

@Processor('lead-research-queue')
export class ResearchProcessor extends WorkerHost {
  constructor(
    private readonly research: ResearchService,
    private readonly logger: StructuredLoggerService,
  ) {
    super();
  }

  async process(job: Job) {
    if (job.name !== 'DEEP_COMPANY_RESEARCH') return { status: 'IGNORED' };
    const data = job.data as DeepResearchJobData;
    this.logger.info('job.deep_research.started', { jobId: job.id, organizationId: data.organizationId, companyId: data.companyId, researchExecutionId: data.researchExecutionId });
    try {
      return await this.research.runQueued(data);
    } catch (error) {
      this.logger.warn('job.deep_research.failed', { jobId: job.id, organizationId: data.organizationId, companyId: data.companyId, researchExecutionId: data.researchExecutionId, errorType: error instanceof Error ? error.name : 'unknown' });
      if (error instanceof NotFoundException) throw new UnrecoverableError('Company or research execution was not found');
      const attempts = job.opts.attempts ?? 1;
      if (job.attemptsMade >= attempts) await this.research.markInterrupted(data, error);
      throw error;
    }
  }
}
