import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { UsersModule } from '../users/users.module';
import { ScoringController } from './scoring.controller';
import { ScoringProcessor } from './scoring.processor';
import { ScoringQueue } from './scoring.queue';
import { ScoringService } from './scoring.service';

@Module({
  imports: [ConfigModule, AuthModule, UsersModule, OrganizationsModule, BullModule.registerQueue({ name: 'lead-scoring-queue' })],
  controllers: [ScoringController],
  providers: [ScoringService, ScoringQueue, ScoringProcessor],
  exports: [ScoringService, ScoringQueue],
})
export class ScoringModule {}
