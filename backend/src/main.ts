import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';

import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/global-exception.filter';
import { RequestIdMiddleware } from './common/request-id.middleware';
import { MetricsService } from './common/observability/metrics.service';
import { RequestContextService } from './common/observability/request-context.service';
import { StructuredLoggerService } from './common/observability/structured-logger.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);
  const requestIdMiddleware = new RequestIdMiddleware(
    app.get(RequestContextService),
    app.get(MetricsService),
    app.get(StructuredLoggerService),
  );

  app.use(helmet());
  app.use(requestIdMiddleware.use.bind(requestIdMiddleware));

  const corsOrigin = configService.get<string>('corsOrigin', 'http://localhost:3000,http://localhost:5173');
  app.enableCors({
    origin: corsOrigin.split(',').map((origin) => origin.trim()),
  });

  app.setGlobalPrefix(
    process.env.API_PREFIX ?? 'api/v1',
  );

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new GlobalExceptionFilter(
    configService,
    app.get(StructuredLoggerService),
    app.get(MetricsService),
  ));

  const port = parseInt(
    process.env.PORT ?? '3000',
    10,
  );

  await app.listen(port);

  app.get(StructuredLoggerService).info('application.started', { port });
}

void bootstrap();