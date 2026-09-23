import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import configuration, { validateEnvironment } from './config/configuration';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CommonModule } from './common/common.module';
import { RedisModule } from './redis/redis.module';
import { DatabaseModule } from './database/database.module';
import { QueueModule } from './queue/queue.module';
import { HealthModule } from './health/health.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { OrganizationsModule } from './organizations/organizations.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      envFilePath: ['.env'],
      validate: validateEnvironment,
    }),
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        throttlers: [
          {
            ttl: configService.get<number>('throttler.ttl', 60000),
            limit: configService.get<number>('throttler.limit', 100),
          },
        ],
      }),
    }),
    CommonModule,
    RedisModule,
    DatabaseModule,
    QueueModule,
    HealthModule,
    UsersModule,
    OrganizationsModule,
    AuthModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}