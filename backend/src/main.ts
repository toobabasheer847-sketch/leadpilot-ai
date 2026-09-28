import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';

import { AppModule } from './app.module';
import { isAllowedCorsOrigin } from './config/configuration';
import { GlobalExceptionFilter } from './common/global-exception.filter';
import { RequestIdMiddleware } from './common/request-id.middleware';
import { MetricsService } from './common/observability/metrics.service';
import { RequestContextService } from './common/observability/request-context.service';
import { StructuredLoggerService } from './common/observability/structured-logger.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  const configService = app.get(ConfigService);
  const requestIdMiddleware = new RequestIdMiddleware(
    app.get(RequestContextService),
    app.get(MetricsService),
    app.get(StructuredLoggerService),
  );

  app.use(helmet());
  app.use(requestIdMiddleware.use.bind(requestIdMiddleware));

  const corsOrigin = configService.get<string>('corsOrigin', 'http://localhost:3000,http://localhost:5173');
  const nodeEnv = configService.get<string>('nodeEnv', 'development');
  app.enableCors({
    origin: (
      origin: string | undefined,
      callback: (error: Error | null, allow?: boolean) => void,
    ) => {
      callback(null, isAllowedCorsOrigin(origin, corsOrigin, nodeEnv) || isNgrokTunnelOrigin(origin));
    },
  });

  app.use('/', (request: Request, response: Response, next: NextFunction) => {
    if (request.method === 'GET' && request.path === '/') {
      response.status(200).json({ status: 'ok', message: 'Server is running' });
      return;
    }
    next();
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

function isNgrokTunnelOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    const hostname = url.hostname.toLowerCase();
    return url.protocol === 'https:'
      && (hostname === 'ngrok-free.dev' || hostname.endsWith('.ngrok-free.dev')
        || hostname === 'ngrok.io' || hostname.endsWith('.ngrok.io'));
  } catch {
    return false;
  }
}

void bootstrap();