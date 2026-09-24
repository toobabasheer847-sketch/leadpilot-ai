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
import { SearchModule } from './search/search.module';
import { EnrichmentModule } from './enrichment/enrichment.module';
import { ContactsModule } from './contacts/contacts.module';
import { ClassificationModule } from './ai/classification/classification.module';
import { VerificationModule } from './verification/verification.module';
import { ScoringModule } from './scoring/scoring.module';
import { DeduplicationModule } from './deduplication/deduplication.module';
import { LeadsModule } from './leads/leads.module';
import { ExportsModule } from './exports/exports.module';
import { UsageModule } from './usage/usage.module';
import { ObservabilityModule } from './common/observability/observability.module';
import { QualificationModule } from './qualification/qualification.module';
import { PipelineModule } from './pipeline/pipeline.module';
import { ResearchModule } from './research/research.module';

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
    ObservabilityModule,
    RedisModule,
    DatabaseModule,
    QueueModule,
    HealthModule,
    UsersModule,
    OrganizationsModule,
    AuthModule,
    SearchModule,
    EnrichmentModule,
    ContactsModule,
    ClassificationModule,
    VerificationModule,
    ScoringModule,
    DeduplicationModule,
    LeadsModule,
    ExportsModule,
    UsageModule,
    QualificationModule,
    PipelineModule,
    ResearchModule,
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