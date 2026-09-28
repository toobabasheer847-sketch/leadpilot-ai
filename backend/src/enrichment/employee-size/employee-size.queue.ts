import { createHash } from 'node:crypto';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import type { EmployeeSizeJobData } from './employee-size.service';

export const EMPLOYEE_SIZE_QUEUE = 'employee-size-queue';

export function employeeSizeJobId(organizationId: string, companyId: string) {
  return `employee-size-${createHash('sha256').update(`${organizationId}:${companyId}`).digest('hex').slice(0, 40)}`;
}

@Injectable()
export class EmployeeSizeQueue {
  constructor(@InjectQueue(EMPLOYEE_SIZE_QUEUE) private readonly queue: Queue) {}

  enqueue(data: EmployeeSizeJobData): Promise<Job<EmployeeSizeJobData>> {
    return this.queue.add('EMPLOYEE_SIZE', data, {
      jobId: employeeSizeJobId(data.organizationId, data.companyId),
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: true,
      removeOnFail: false,
    });
  }
}
