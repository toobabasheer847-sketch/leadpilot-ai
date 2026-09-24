import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { ExportsService } from './exports.service';
import type { ExportJobData } from './types/export.types';

@Processor('lead-export-queue')
export class ExportsProcessor extends WorkerHost {
  constructor(private readonly service: ExportsService) { super(); }
  process(job: Job<ExportJobData>) { return this.service.process(job.data); }
}
