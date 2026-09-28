import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, UnrecoverableError } from 'bullmq';
import { isWebSearchError } from '../website/web-search.error';
import { EMPLOYEE_SIZE_QUEUE } from './employee-size.queue';
import { EmployeeSizeService, type EmployeeSizeJobData } from './employee-size.service';

@Processor(EMPLOYEE_SIZE_QUEUE, { concurrency: 4, lockDuration: 300_000, lockRenewTime: 15_000, stalledInterval: 30_000, maxStalledCount: 2 })
export class EmployeeSizeProcessor extends WorkerHost {
  constructor(private readonly employeeSize: EmployeeSizeService) {
    super();
  }

  async process(job: Job<EmployeeSizeJobData>) {
    try {
      return await this.employeeSize.collect(job.data);
    } catch (error) {
      if (isWebSearchError(error) && !error.retryable) throw new UnrecoverableError(error.message);
      throw error;
    }
  }
}
