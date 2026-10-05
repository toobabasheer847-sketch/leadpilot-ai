import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { BULL_DEFAULT_JOB_OPTIONS, bullConnectionOptions } from './bull-connection';
import { LeadResearchQueue } from './lead-research.queue';
import { QueueObservabilityService } from './queue-observability.service';
import { QueueShutdownService } from './queue-shutdown.service';

@Module({
  imports: [
    DiscoveryModule,
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const redisUrl = configService.get<string>('redis.url') || 'redis://127.0.0.1:6379';
        return {
          connection: bullConnectionOptions(redisUrl),
          defaultJobOptions: BULL_DEFAULT_JOB_OPTIONS,
          forceDisconnectOnShutdown: true,
        };
      },
    }),
    BullModule.registerQueue({
      name: 'lead-research-queue',
    }),
  ],
  providers: [LeadResearchQueue, QueueObservabilityService, QueueShutdownService],
  exports: [BullModule, LeadResearchQueue],
})
export class QueueModule {}
