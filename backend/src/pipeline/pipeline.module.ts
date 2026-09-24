import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AuthModule } from '../auth/auth.module';
import { SearchModule } from '../search/search.module';
import { EnrichmentModule } from '../enrichment/enrichment.module';
import { ContactsModule } from '../contacts/contacts.module';
import { ClassificationModule } from '../ai/classification/classification.module';
import { VerificationModule } from '../verification/verification.module';
import { DeduplicationModule } from '../deduplication/deduplication.module';
import { ScoringModule } from '../scoring/scoring.module';
import { QualificationModule } from '../qualification/qualification.module';
import { ResearchModule } from '../research/research.module';
import { UsageModule } from '../usage/usage.module';
import { LEAD_PIPELINE_QUEUE } from './pipeline.constants';
import { PipelineController } from './pipeline.controller';
import { PipelineJobInspector } from './pipeline.job-inspector';
import { PipelineProcessor } from './pipeline.processor';
import { PipelineQueue } from './pipeline.queue';
import { PipelineRepository } from './pipeline.repository';
import { PipelineStageRunner } from './pipeline.runner';
import { PipelineService } from './pipeline.service';

@Module({
  imports: [
    AuthModule,
    UsageModule,
    SearchModule,
    EnrichmentModule,
    ContactsModule,
    ClassificationModule,
    VerificationModule,
    DeduplicationModule,
    ScoringModule,
    QualificationModule,
    ResearchModule,
    BullModule.registerQueue(
      { name: LEAD_PIPELINE_QUEUE },
      { name: 'company-enrichment-queue' },
      { name: 'contact-discovery-queue' },
      { name: 'ai-classification-queue' },
      { name: 'lead-verification-queue' },
      { name: 'lead-deduplication-queue' },
      { name: 'lead-scoring-queue' },
      { name: 'lead-qualification-queue' },
      { name: 'lead-research-queue' },
    ),
  ],
  controllers: [PipelineController],
  providers: [PipelineRepository, PipelineQueue, PipelineJobInspector, PipelineStageRunner, PipelineService, PipelineProcessor],
})
export class PipelineModule {}
