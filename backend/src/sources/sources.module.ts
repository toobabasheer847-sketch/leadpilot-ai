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

@Module({
  imports: [
    ConfigModule,
    QueueModule,
    CommonModule,
    BullModule.registerQueue({ name: 'source-discovery-queue' }),
  ],
  providers: [
    SourceNormalizerService,
    GooglePlacesProvider,
    FakeSourceProvider,
    {
      provide: SOURCE_PROVIDER,
      inject: [ConfigService, GooglePlacesProvider, FakeSourceProvider],
      useFactory: (config: ConfigService, google: GooglePlacesProvider, fake: FakeSourceProvider) =>
        config.get<string>('sourceProvider.provider', 'google_places') === 'fake' ? fake : google,
    },
    SourceDiscoveryService,
    SourceDiscoveryProcessor,
    SourceDiscoveryQueue,
  ],
  exports: [SourceDiscoveryQueue, SourceDiscoveryService, SourceNormalizerService],
})
export class SourcesModule {}
