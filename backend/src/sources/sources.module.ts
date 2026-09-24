import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { QueueModule } from '../queue/queue.module';
import { CommonModule } from '../common/common.module';
import { SOURCE_PROVIDER } from './interfaces/source-provider.interface';
import { FakeSourceProvider } from './providers/fake-source.provider';
import { GooglePlacesProvider } from './providers/google-places/google-places.provider';
import { SourceDiscoveryProcessor } from './source-discovery.processor';
import { SourceDiscoveryQueue } from './source-discovery.queue';
import { SourceDiscoveryService } from './services/source-discovery.service';
import { SourceNormalizerService } from './services/source-normalizer.service';
import { UsageModule } from '../usage/usage.module';
import { AuthModule } from '../auth/auth.module';
import { selectDiscoveryProvider } from './providers/provider-selection';
import { DiscoveryProviderRegistry } from './providers/discovery-provider.registry';
import { ProvidersController } from './providers.controller';

@Module({
  imports: [
    ConfigModule,
    QueueModule,
    CommonModule,
    UsageModule,
    AuthModule,
    BullModule.registerQueue({ name: 'source-discovery-queue' }),
  ],
  controllers: [ProvidersController],
  providers: [
    SourceNormalizerService,
    GooglePlacesProvider,
    FakeSourceProvider,
    DiscoveryProviderRegistry,
    {
      provide: SOURCE_PROVIDER,
      inject: [ConfigService, GooglePlacesProvider, FakeSourceProvider],
      useFactory: (config: ConfigService, google: GooglePlacesProvider, fake: FakeSourceProvider) =>
        selectDiscoveryProvider(config.get<string>('nodeEnv', 'development'), config.get<string>('sourceProvider.provider', 'google_places'), google, fake),
    },
    SourceDiscoveryService,
    SourceDiscoveryProcessor,
    SourceDiscoveryQueue,
  ],
  exports: [SourceDiscoveryQueue, SourceDiscoveryService, SourceNormalizerService],
})
export class SourcesModule {}
