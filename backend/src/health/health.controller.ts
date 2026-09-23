import { Controller, Get, Inject } from '@nestjs/common';
import { DRIZZLE } from '../database/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

@Controller('health')
export class HealthController {
  constructor(
    @Inject(DRIZZLE) private db: NodePgDatabase<any>,
    @InjectQueue('lead-research-queue') private leadQueue: Queue,
  ) {}

  @Get()
  async checkHealth() {
    let dbStatus = 'OFFLINE';
    let redisStatus = 'OFFLINE';

    // Check Database Connection
    try {
      await this.db.execute(sql`SELECT 1`);
      dbStatus = 'ONLINE';
    } catch (error: any) {
      dbStatus = `ERROR: ${error?.message || 'Database connection failed'}`;
    }

    // Check Redis Connection via BullMQ Queue
    try {
      await this.leadQueue.getJobCounts();
      redisStatus = 'ONLINE';
    } catch (error: any) {
      redisStatus = `ERROR: ${error?.message || 'Redis connection failed'}`;
    }

    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      services: {
        database: dbStatus,
        redis: redisStatus,
      },
    };
  }
}