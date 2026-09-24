import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { ClassificationService } from './classification.service';
import type { ClassificationJobData } from './classification.queue';

@Processor('ai-classification-queue')
export class ClassificationProcessor extends WorkerHost {
  constructor(private readonly service: ClassificationService) { super(); }

  process(job: Job<ClassificationJobData>) {
    return this.service.classifyQueued(job.data);
  }
}
