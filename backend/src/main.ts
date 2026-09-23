import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';

import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.use(helmet());

  app.enableCors();

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

  const port = parseInt(
    process.env.PORT ?? '3000',
    10,
  );

  await app.listen(port);

  console.log(
    `LeadPilot AI backend running on http://localhost:${port}`,
  );
}

bootstrap();