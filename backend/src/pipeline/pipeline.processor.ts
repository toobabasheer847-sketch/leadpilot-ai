import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { StructuredLoggerService } from '../common/observability/structured-logger.service';
import { LEAD_PIPELINE_QUEUE } from './pipeline.constants';
import { PipelineService } from './pipeline.service';
import type { LeadPipelineJobData } from './pipeline.types';

@Processor(LEAD_PIPELINE_QUEUE)
export class PipelineProcessor extends WorkerHost {
  constructor(
    private readonly pipelines: PipelineService,
    private readonly logger: StructuredLoggerService,
  ) {
    super();
  }

  async process(job: Job<LeadPipelineJobData>) {
    this.logger.info('job.lead_pipeline.started', {
      pipelineExecutionId: job.data.pipelineExecutionId,
      searchExecutionId: job.data.searchExecutionId,
      organizationId: job.data.organizationId,
      jobId: job.id,
    });
    await this.pipelines.runTick(job.data, job.attemptsMade, job.opts.attempts ?? 1);
  }
}
