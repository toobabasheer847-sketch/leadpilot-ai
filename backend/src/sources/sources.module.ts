import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { QueueModule } from '../queue/queue.module';
import { CommonModule } from '../common/common.module';
import { DISCOVERY_PROVIDER_CHAIN, SOURCE_PROVIDER } from './interfaces/source-provider.interface';
import { FakeSourceProvider } from './providers/fake-source.provider';
import { GooglePlacesProvider } from './providers/google-places/google-places.provider';
import { OsmSourceProvider } from './providers/osm/osm.provider';
import { OpenRouterDiscoveryProvider } from './providers/openrouter/openrouter-discovery.provider';
import { SourceDiscoveryProcessor } from './source-discovery.processor';
import { SourceDiscoveryQueue } from './source-discovery.queue';
import { SourceDiscoveryService } from './services/source-discovery.service';
import { SourceNormalizerService } from './services/source-normalizer.service';
import { UsageModule } from '../usage/usage.module';
import { AuthModule } from '../auth/auth.module';
import { discoveryMapProviderChain, resolveDiscoveryProvider } from './providers/provider-selection';
import { DiscoveryProviderRegistry } from './providers/discovery-provider.registry';
import { WebSearchCompanyDiscovery } from './providers/web-search/web-search-company.discovery';
import { ProvidersController } from './providers.controller';
import { EnrichmentModule } from '../enrichment/enrichment.module';

@Module({
  imports: [
    ConfigModule,
    QueueModule,
    CommonModule,
    UsageModule,
    AuthModule,
    EnrichmentModule,
    BullModule.registerQueue({ name: 'source-discovery-queue' }),
  ],
  controllers: [ProvidersController],
  providers: [
    SourceNormalizerService,
    GooglePlacesProvider,
    OsmSourceProvider,
    OpenRouterDiscoveryProvider,
    FakeSourceProvider,
    DiscoveryProviderRegistry,
    WebSearchCompanyDiscovery,
    {
      provide: SOURCE_PROVIDER,
      inject: [ConfigService, GooglePlacesProvider, OsmSourceProvider, FakeSourceProvider, OpenRouterDiscoveryProvider],
      useFactory: (config: ConfigService, google: GooglePlacesProvider, osm: OsmSourceProvider, fake: FakeSourceProvider, openRouter: OpenRouterDiscoveryProvider) =>
        resolveDiscoveryProvider(
          config.get<string>('nodeEnv', 'development'),
          config.get<string>('sourceProvider.provider', 'google_places'),
          google,
          osm,
          fake,
          config.get<string>('webSearch.tavilyApiKey'),
          openRouter,
        ),
    },
    {
      provide: DISCOVERY_PROVIDER_CHAIN,
      inject: [ConfigService, GooglePlacesProvider, OsmSourceProvider, FakeSourceProvider, OpenRouterDiscoveryProvider],
      useFactory: (config: ConfigService, google: GooglePlacesProvider, osm: OsmSourceProvider, fake: FakeSourceProvider, openRouter: OpenRouterDiscoveryProvider) =>
        discoveryMapProviderChain(
          config.get<string>('nodeEnv', 'development'),
          config.get<string>('sourceProvider.provider', 'google_places'),
          google,
          osm,
          fake,
          config.get<string>('webSearch.tavilyApiKey'),
          openRouter,
        ),
    },
    SourceDiscoveryService,
    SourceDiscoveryProcessor,
    SourceDiscoveryQueue,
  ],
  exports: [SourceDiscoveryQueue, SourceDiscoveryService, SourceNormalizerService],
})
export class SourcesModule {}
