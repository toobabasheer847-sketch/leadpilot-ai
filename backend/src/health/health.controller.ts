import { Controller, Get, Inject } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { DRIZZLE } from '../database/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { RedisService } from '../redis/redis.service';

@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    @Inject(DRIZZLE) private db: NodePgDatabase<any>,
    @InjectQueue('lead-research-queue') private leadQueue: Queue,
    private readonly redisService: RedisService,
  ) {}

  @Get()
  async checkHealth() {
    let dbStatus = 'down';
    let redisStatus = 'down';

    // Check Database Connection
    try {
      await this.db.execute(sql`SELECT 1`);
      dbStatus = 'up';
    } catch (error: unknown) {
      this.logger.warn(`Database health check failed: ${error instanceof Error ? error.name : 'unknown error'}`);
      dbStatus = 'down';
    }

    // Check Redis Connection via BullMQ Queue
    try {
      await this.leadQueue.getJobCounts();
      redisStatus = (await this.redisService.ping()) ? 'up' : 'down';
    } catch (error: unknown) {
      this.logger.warn(`Redis health check failed: ${error instanceof Error ? error.name : 'unknown error'}`);
      redisStatus = 'down';
    }

    return {
      status: dbStatus === 'up' && redisStatus === 'up' ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      services: {
        database: dbStatus,
        redis: redisStatus,
      },
    };
  }
}