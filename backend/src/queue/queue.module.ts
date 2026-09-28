import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { redisEndpoint } from '../redis/redis-endpoint';
import { LeadResearchQueue } from './lead-research.queue';
import { QueueObservabilityService } from './queue-observability.service';

@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const redisUrl = configService.get<string>('redis.url') || 'redis://127.0.0.1:6379';
        return {
          connection: {
            ...redisEndpoint(redisUrl),
            maxRetriesPerRequest: null,
            connectTimeout: 10_000,
            retryStrategy(times: number) {
              return Math.min(times * 500, 5_000);
            },
          },
        };
      },
    }),
    BullModule.registerQueue({
      name: 'lead-research-queue',
    }),
  ],
  providers: [LeadResearchQueue, QueueObservabilityService],
  exports: [BullModule, LeadResearchQueue],
})
export class QueueModule {}
