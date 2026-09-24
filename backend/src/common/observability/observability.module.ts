import { Global, Module } from '@nestjs/common';
import { MetricsService } from './metrics.service';
import { RequestContextService } from './request-context.service';
import { StructuredLoggerService } from './structured-logger.service';
import { MetricsController } from './metrics.controller';
import { ProviderObservabilityService } from './provider-observability.service';

@Global()
@Module({
  providers: [MetricsService, RequestContextService, StructuredLoggerService, ProviderObservabilityService],
  controllers: [MetricsController],
  exports: [MetricsService, RequestContextService, StructuredLoggerService, ProviderObservabilityService],
})
export class ObservabilityModule {}