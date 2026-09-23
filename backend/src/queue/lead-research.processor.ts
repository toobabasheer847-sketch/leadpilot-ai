import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';

@Processor('lead-research-queue')
export class LeadResearchProcessor extends WorkerHost {
  private readonly logger = new Logger(LeadResearchProcessor.name);

  async process(job: Job<unknown, unknown, string>): Promise<{ status: string; message: string }> {
    const startedAt = Date.now();
    this.logger.log(`Processing job ${job.id} (${job.name}) on lead-research-queue`);

   
    await new Promise((resolve) => setTimeout(resolve, 3000));

    this.logger.log(`Job ${job.id} completed with status COMPLETED in ${Date.now() - startedAt}ms`);

    return {
      status: 'COMPLETED',
      message: 'Research pipeline completed',
    };
  }
}