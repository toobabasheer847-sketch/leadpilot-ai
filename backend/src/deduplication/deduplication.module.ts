import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { UsersModule } from '../users/users.module';
import { DeduplicationController } from './deduplication.controller';
import { DeduplicationProcessor } from './deduplication.processor';
import { DeduplicationQueue } from './deduplication.queue';
import { DeduplicationService } from './deduplication.service';

@Module({
  imports: [ConfigModule, AuthModule, UsersModule, OrganizationsModule, BullModule.registerQueue({ name: 'lead-deduplication-queue' })],
  controllers: [DeduplicationController],
  providers: [DeduplicationService, DeduplicationQueue, DeduplicationProcessor],
  exports: [DeduplicationService, DeduplicationQueue],
})
export class DeduplicationModule {}
