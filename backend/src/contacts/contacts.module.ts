import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { ContactDiscoveryQueue } from './contact-discovery.queue';
import { ContactDiscoveryProcessor } from './contact-discovery.processor';
import { ContactsController } from './contacts.controller';
import { ContactsService } from './contacts.service';
import { PersonCandidateService } from './discovery/person-candidate.service';
import { PersonDiscoveryService } from './discovery/person-discovery.service';
import { ContactExtractorService } from './extraction/contact-extractor.service';
import { PersonIdentityMatcherService } from './matching/person-identity-matcher.service';
import { CONTACT_DISCOVERY_PROVIDER } from './providers/contact-provider.interface';
import { WebsiteContactProvider } from './providers/website-contact.provider';
import { ContactEvidenceService } from './verification/contact-evidence.service';
import { EnrichmentModule } from '../enrichment/enrichment.module';
import { ScoringModule } from '../scoring/scoring.module';
import { ContactQualityQueue } from './quality/contact-quality.queue';
import { ContactQualityProcessor } from './quality/contact-quality.processor';
import { ContactQualityService } from './quality/contact-quality.service';
import { UsageModule } from '../usage/usage.module';

@Module({
  imports: [ConfigModule, AuthModule, UsersModule, EnrichmentModule, UsageModule, ScoringModule, BullModule.registerQueue({ name: 'contact-discovery-queue' }), BullModule.registerQueue({ name: 'contact-quality-queue' })],
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
    ContactQualityService,
    ContactQualityQueue,
    ContactQualityProcessor,
    {
      provide: CONTACT_DISCOVERY_PROVIDER,
      useExisting: WebsiteContactProvider,
    },
  ],
  exports: [ContactsService, ContactDiscoveryQueue],
})
export class ContactsModule {}
