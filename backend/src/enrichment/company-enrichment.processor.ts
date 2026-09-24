import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { EnrichmentService } from './enrichment.service';
import { CompanyEnrichmentJobData } from './website/website.types';

@Processor('company-enrichment-queue')
export class CompanyEnrichmentProcessor extends WorkerHost {
  private readonly logger = new Logger(CompanyEnrichmentProcessor.name);

  constructor(@Inject(EnrichmentService) private readonly enrichmentService: EnrichmentService) {
    super();
  }

  async process(job: Job<CompanyEnrichmentJobData>) {
    this.logger.log(`Processing company enrichment job ${job.id}`);
    const result = await this.enrichmentService.runCompanyEnrichment(job.data);
    return result;
  }
}
