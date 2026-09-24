import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';

export class LeadResearchProcessor {
  private readonly logger = new Logger(LeadResearchProcessor.name);

  async process(job: Job<unknown, unknown, string>): Promise<{ status: string; message: string }> {
    this.logger.log(`Ignored placeholder research job ${job.id}`);
    return { status: 'IGNORED', message: 'Deep company research is handled by the research module.' };
  }
}
