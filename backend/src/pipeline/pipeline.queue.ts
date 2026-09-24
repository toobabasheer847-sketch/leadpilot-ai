import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { LEAD_PIPELINE_JOB, LEAD_PIPELINE_QUEUE, STAGE_WAIT_DELAY_MS } from './pipeline.constants';
import { pipelineJobId } from './pipeline.progress';
import type { LeadPipelineJobData } from './pipeline.types';

@Injectable()
export class PipelineQueue {
  constructor(@InjectQueue(LEAD_PIPELINE_QUEUE) private readonly queue: Queue<LeadPipelineJobData>) {}

  enqueue(data: LeadPipelineJobData, stage: string, wait = 0) {
    return this.queue.add(LEAD_PIPELINE_JOB, data, {
      jobId: pipelineJobId(data.pipelineExecutionId, stage, wait),
      delay: wait > 0 ? STAGE_WAIT_DELAY_MS : 0,
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: true,
      removeOnFail: 100,
    });
  }

  async removePending(pipelineExecutionId: string, stage: string, wait: number) {
    const job = await this.queue.getJob(pipelineJobId(pipelineExecutionId, stage, wait));
    if (!job) return;
    const state = await job.getState();
    if (state === 'waiting' || state === 'delayed' || state === 'prioritized') await job.remove();
  }
}
