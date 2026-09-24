import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import type { ExportJobData } from './types/export.types';

@Injectable()
export class ExportsQueue {
  constructor(@InjectQueue('lead-export-queue') private readonly queue: Queue) {}

  enqueue(data: ExportJobData): Promise<Job<ExportJobData>> {
    return this.queue.add('LEAD_EXPORT', data, { jobId: data.exportId, attempts: 3, backoff: { type: 'exponential', delay: 2000 }, removeOnComplete: true, removeOnFail: false });
  }
}
