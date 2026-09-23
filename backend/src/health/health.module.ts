import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { QueueModule } from '../queue/queue.module';
import { RedisModule } from '../redis/redis.module';

@Module({
  imports: [QueueModule, RedisModule],
  controllers: [HealthController],
})
export class HealthModule {}