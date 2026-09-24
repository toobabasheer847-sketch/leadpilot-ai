import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { LeadResearchQueue } from './lead-research.queue';
import { QueueObservabilityService } from './queue-observability.service';

@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const redisUrl = configService.get<string>('redis.url') || 'redis://localhost:6379';
        const url = new URL(redisUrl);

        return {
          connection: {
            host: url.hostname || 'localhost',
            port: parseInt(url.port || '6379', 10),
            password: url.password || undefined,
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