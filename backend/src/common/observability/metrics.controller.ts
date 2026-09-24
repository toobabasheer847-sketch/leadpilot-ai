import { Controller, Get, Header, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MetricsService } from './metrics.service';

@Controller('metrics')
export class MetricsController {
  constructor(
    private readonly metrics: MetricsService,
    private readonly config: ConfigService,
  ) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4')
  getMetrics() {
    if (this.config.get<string>('metrics.enabled', 'true') !== 'true') throw new ServiceUnavailableException('Metrics are disabled');
    return this.metrics.toPrometheus();
  }
}