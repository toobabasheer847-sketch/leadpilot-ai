import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { publicErrorMessage } from './pipeline.progress';

export type JobSettlement = { state: 'COMPLETED' } | { state: 'PENDING' } | { state: 'FAILED'; message: string };

@Injectable()
export class PipelineJobInspector {
  private readonly queues: Record<string, Queue>;

  constructor(
    @InjectQueue('company-enrichment-queue') enrichment: Queue,
    @InjectQueue('contact-discovery-queue') contacts: Queue,
    @InjectQueue('ai-classification-queue') classification: Queue,
    @InjectQueue('lead-verification-queue') verification: Queue,
    @InjectQueue('lead-deduplication-queue') deduplication: Queue,
    @InjectQueue('lead-scoring-queue') scoring: Queue,
    @InjectQueue('lead-qualification-queue') qualification: Queue,
    @InjectQueue('lead-research-queue') research: Queue,
  ) {
    this.queues = {
      'company-enrichment-queue': enrichment,
      'contact-discovery-queue': contacts,
      'ai-classification-queue': classification,
      'lead-verification-queue': verification,
      'lead-deduplication-queue': deduplication,
      'lead-scoring-queue': scoring,
      'lead-qualification-queue': qualification,
      'lead-research-queue': research,
    };
  }

  async settle(queueName: string, jobIds: string[]): Promise<JobSettlement> {
    if (jobIds.length === 0) return { state: 'COMPLETED' };
    const queue = this.queues[queueName];
    if (!queue) return { state: 'FAILED', message: 'Pipeline stage queue is unavailable.' };

    for (const jobId of jobIds) {
      const job = await queue.getJob(jobId);
      if (!job) continue;
      const state = await job.getState();
      if (state === 'failed') return { state: 'FAILED', message: publicErrorMessage(job.failedReason || 'Pipeline stage failed.') };
      if (state !== 'completed') return { state: 'PENDING' };
    }
    return { state: 'COMPLETED' };
  }
}
