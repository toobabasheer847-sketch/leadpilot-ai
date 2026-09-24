import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { ContactsService } from './contacts.service';
import { ContactDiscoveryJobData } from './contact-discovery.queue';

@Processor('contact-discovery-queue')
export class ContactDiscoveryProcessor extends WorkerHost {
  private readonly logger = new Logger(ContactDiscoveryProcessor.name);

  constructor(private readonly contactsService: ContactsService) {
    super();
  }

  async process(job: Job<ContactDiscoveryJobData>) {
    this.logger.log(`Processing contact discovery for company ${job.data.companyId}`);
    return this.contactsService.discoverForCompany(job.data.companyId, job.data.organizationId, job.data.searchExecutionId ?? null);
  }
}
