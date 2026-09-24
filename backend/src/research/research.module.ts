import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { ClassificationModule } from '../ai/classification/classification.module';
import { AuthModule } from '../auth/auth.module';
import { ContactsModule } from '../contacts/contacts.module';
import { EnrichmentModule } from '../enrichment/enrichment.module';
import { QueueModule } from '../queue/queue.module';
import { UsageModule } from '../usage/usage.module';
import { VerificationModule } from '../verification/verification.module';
import { ResearchController } from './research.controller';
import { ResearchProcessor } from './research.processor';
import { ResearchQueue } from './research.queue';
import { ResearchService } from './research.service';

@Module({
  imports: [
    ConfigModule,
    AuthModule,
    QueueModule,
    BullModule.registerQueue({ name: 'lead-research-queue' }),
    EnrichmentModule,
    ContactsModule,
    VerificationModule,
    ClassificationModule,
    UsageModule,
  ],
  controllers: [ResearchController],
  providers: [ResearchService, ResearchQueue, ResearchProcessor],
  exports: [ResearchService],
})
export class ResearchModule {}
