import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';

@Processor('lead-research-queue')
export class LeadResearchProcessor extends WorkerHost {
  private readonly logger = new Logger(LeadResearchProcessor.name);

  async process(job: Job<any, any, string>): Promise<any> {
    this.logger.log(`Processing job ${job.id} of type ${job.name}...`);
    this.logger.log(`Job Payload: ${JSON.stringify(job.data)}`);

   
    await new Promise((resolve) => setTimeout(resolve, 3000));

    this.logger.log(`Job ${job.id} completed successfully!`);

    return {
      status: 'COMPLETED',
      message: 'Research pipeline completed',
    };
  }
}