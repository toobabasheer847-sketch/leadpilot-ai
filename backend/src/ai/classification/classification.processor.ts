import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, UnrecoverableError } from 'bullmq';
import { ClassificationService } from './classification.service';
import type { ClassificationJobData } from './classification.queue';
import { OpenRouterError } from './providers/openrouter.provider';

@Processor('ai-classification-queue', { lockDuration: 180_000, lockRenewTime: 15_000, stalledInterval: 30_000, maxStalledCount: 2 })
export class ClassificationProcessor extends WorkerHost {
  constructor(private readonly service: ClassificationService) { super(); }

  process(job: Job<ClassificationJobData>) {
    return this.service.classifyQueued(job.data).catch((error: unknown) => {
      if (error instanceof OpenRouterError && !error.retryable) throw new UnrecoverableError(error.message);
      throw error;
    });
  }
}
