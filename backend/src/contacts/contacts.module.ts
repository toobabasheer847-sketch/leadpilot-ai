import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { ContactDiscoveryQueue } from './contact-discovery.queue';
import { ContactDiscoveryProcessor } from './contact-discovery.processor';
import { ContactsController } from './contacts.controller';
import { ContactsService } from './contacts.service';
import { PersonCandidateService } from './discovery/person-candidate.service';
import { PersonDiscoveryService } from './discovery/person-discovery.service';
import { ContactExtractorService } from './extraction/contact-extractor.service';
import { PersonIdentityMatcherService } from './matching/person-identity-matcher.service';
import { ContactDiscoveryProvider } from './providers/contact-provider.interface';
import { WebsiteContactProvider } from './providers/website-contact.provider';
import { ContactEvidenceService } from './verification/contact-evidence.service';

@Module({
  imports: [ConfigModule, BullModule.registerQueue({ name: 'contact-discovery-queue' })],
  controllers: [ContactsController],
  providers: [
    ContactsService,
    ContactExtractorService,
    PersonCandidateService,
    PersonIdentityMatcherService,
    WebsiteContactProvider,
    PersonDiscoveryService,
    ContactEvidenceService,
    ContactDiscoveryQueue,
    ContactDiscoveryProcessor,
    {
      provide: ContactDiscoveryProvider,
      useExisting: WebsiteContactProvider,
    },
  ],
  exports: [ContactsService, ContactDiscoveryQueue],
})
export class ContactsModule {}
