import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { RedisService } from '../redis/redis.service';
import { DatabaseService } from '../database/database.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly databaseService: DatabaseService,
    @InjectQueue('lead-research-queue') private leadQueue: Queue,
    private readonly redisService: RedisService,
  ) {}

  @Get()
  async checkHealth() {
    const dbStatus = await this.databaseStatus();
    const redisStatus = await this.redisStatus();
    const queueStatus = await this.queueStatus();
    const dependenciesUp = dbStatus === 'up' && redisStatus === 'up' && queueStatus === 'up';
    return { status: dependenciesUp ? 'ok' : 'degraded', timestamp: new Date().toISOString(), services: { application: 'up', database: dbStatus, redis: redisStatus, queue: queueStatus } };
  }

  @Get('live')
  live() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) response: Response) {
    const health = await this.checkHealth();
    if (health.status !== 'ok') response.status(HttpStatus.SERVICE_UNAVAILABLE);
    return health;
  }

  private async databaseStatus() {
    try {
      await this.databaseService.ping();
      return 'up';
    } catch { return 'down'; }
  }

  private async redisStatus() {
    try {
      return (await this.redisService.ping()) ? 'up' : 'down';
    } catch { return 'down'; }
  }

  private async queueStatus() {
    try {
      await this.leadQueue.getJobCounts();
      return 'up';
    } catch { return 'down'; }
  }
}