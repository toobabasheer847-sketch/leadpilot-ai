import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../../auth/auth.module';
import { UsersModule } from '../../users/users.module';
import { OrganizationsModule } from '../../organizations/organizations.module';
import { UsageModule } from '../../usage/usage.module';
import { ClassificationController } from './classification.controller';
import { ClassificationProcessor } from './classification.processor';
import { ClassificationQueue } from './classification.queue';
import { ClassificationService } from './classification.service';
import { LLM_PROVIDER } from './providers/llm-provider.interface';
import { OpenRouterProvider } from './providers/openrouter.provider';

@Module({
  imports: [ConfigModule, AuthModule, UsersModule, OrganizationsModule, UsageModule, BullModule.registerQueue({ name: 'ai-classification-queue' })],
  controllers: [ClassificationController],
  providers: [
    ClassificationService,
    ClassificationQueue,
    ClassificationProcessor,
    OpenRouterProvider,
    { provide: LLM_PROVIDER, useExisting: OpenRouterProvider },
  ],
  exports: [ClassificationService, ClassificationQueue],
})
export class ClassificationModule {}
