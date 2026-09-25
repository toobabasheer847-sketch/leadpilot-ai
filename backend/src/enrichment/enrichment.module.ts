import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { CompanyController } from './company.controller';
import { CompanyEnrichmentProcessor } from './company-enrichment.processor';
import { CompanyEnrichmentQueue } from './company-enrichment.queue';
import { EnrichmentService } from './enrichment.service';
import { CompanyEnrichmentRepository } from './repositories/company-enrichment.repository';
import { EvidenceRepository } from './repositories/evidence.repository';
import { CompanySocialDiscoveryService } from './social/company-social-discovery.service';
import { TavilyWebSearchProvider } from './website/tavily-web-search.provider';
import { WEB_SEARCH_PROVIDER } from './website/web-search.types';
import { WebsiteDiscoveryService } from './website/website-discovery.service';
import { WebsiteFetchService } from './website/website-fetch.service';
import { WebsiteNormalizerService } from './website/website-normalizer.service';
import { WebsiteParserService } from './website/website-parser.service';
import { UsageModule } from '../usage/usage.module';

@Module({
  imports: [ConfigModule, AuthModule, UsersModule, OrganizationsModule, UsageModule, BullModule.registerQueue({ name: 'company-enrichment-queue' })],
  controllers: [CompanyController],
  providers: [
    WebsiteNormalizerService,
    WebsiteFetchService,
    TavilyWebSearchProvider,
    { provide: WEB_SEARCH_PROVIDER, useExisting: TavilyWebSearchProvider },
    WebsiteDiscoveryService,
    WebsiteParserService,
    CompanySocialDiscoveryService,
    CompanyEnrichmentRepository,
    EvidenceRepository,
    CompanyEnrichmentQueue,
    CompanyEnrichmentProcessor,
    EnrichmentService,
  ],
  exports: [EnrichmentService, CompanyEnrichmentQueue, WebsiteNormalizerService, WebsiteFetchService, WebsiteDiscoveryService, WebsiteParserService, EvidenceRepository],
})
export class EnrichmentModule {}
