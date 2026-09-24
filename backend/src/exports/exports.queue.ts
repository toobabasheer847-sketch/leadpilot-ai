import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import type { ExportJobData } from './types/export.types';
import { RequestContextService } from '../common/observability/request-context.service';

@Injectable()
export class ExportsQueue {
  constructor(@InjectQueue('lead-export-queue') private readonly queue: Queue, private readonly context: RequestContextService) {}

  enqueue(data: ExportJobData): Promise<Job<ExportJobData>> {
    return this.queue.add('LEAD_EXPORT', { ...data, correlationId: this.context.get()?.correlationId }, { jobId: data.exportId, attempts: 3, backoff: { type: 'exponential', delay: 2000 }, removeOnComplete: true, removeOnFail: false });
  }
}
