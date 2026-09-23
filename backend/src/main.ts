import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';

import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/global-exception.filter';
import { RequestIdMiddleware } from './common/request-id.middleware';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);
  const requestIdMiddleware = new RequestIdMiddleware();

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
  app.useGlobalFilters(new GlobalExceptionFilter());

  const port = parseInt(
    process.env.PORT ?? '3000',
    10,
  );

  await app.listen(port);

  console.log(
    `LeadPilot AI backend running on http://localhost:${port}`,
  );
}

void bootstrap();