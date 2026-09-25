import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { publicErrorMessage, summarizeJobStates, summarizeWebsiteFindings, type ObservedJobState } from './pipeline.progress';

export type JobSettlement = { state: 'COMPLETED' } | { state: 'PENDING' } | { state: 'FAILED'; message: string } | { state: 'PARTIAL'; message: string };

@Injectable()
export class PipelineJobInspector {
  private readonly queues: Record<string, Queue>;

  constructor(
    @InjectQueue('company-enrichment-queue') enrichment: Queue,
    @InjectQueue('contact-discovery-queue') contacts: Queue,
    @InjectQueue('contact-quality-queue') quality: Queue,
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
      'contact-quality-queue': quality,
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

    const observed: ObservedJobState[] = [];
    const websiteOutcomes: Array<'FOUND' | 'NOT_FOUND'> = [];
    let failureMessage = 'Pipeline stage failed.';
    for (const jobId of jobIds) {
      const job = await queue.getJob(jobId);
      if (!job) {
        observed.push('missing');
        continue;
      }
      const state = await job.getState();
      if (state === 'failed') {
        observed.push('failed');
        failureMessage = publicErrorMessage(job.failedReason || failureMessage);
        continue;
      }
      if (state !== 'completed') return { state: 'PENDING' };
      observed.push('completed');
      const websiteStatus = websiteStatusFrom(job.returnvalue);
      if (websiteStatus) websiteOutcomes.push(websiteStatus);
    }
    const summary = summarizeJobStates(observed.map((state) => state === 'missing' ? 'completed' : state), failureMessage);
    if (summary.state === 'COMPLETED' && queueName === 'company-enrichment-queue') return summarizeWebsiteFindings(websiteOutcomes) ?? summary;
    return summary;
  }
}

function websiteStatusFrom(value: unknown): 'FOUND' | 'NOT_FOUND' | null {
  if (!value || typeof value !== 'object' || !('websiteStatus' in value)) return null;
  const status = (value as { websiteStatus?: unknown }).websiteStatus;
  return status === 'FOUND' || status === 'NOT_FOUND' ? status : null;
}
