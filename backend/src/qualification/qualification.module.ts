import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { UsersModule } from '../users/users.module';
import { UsageModule } from '../usage/usage.module';
import { QualificationController } from './qualification.controller';
import { QualificationProcessor } from './qualification.processor';
import { QualificationQueue } from './qualification.queue';
import { QualificationService } from './qualification.service';

@Module({
  imports: [
    ConfigModule,
    AuthModule,
    UsersModule,
    OrganizationsModule,
    UsageModule,
    BullModule.registerQueue({ name: 'lead-qualification-queue' }),
  ],
  controllers: [QualificationController],
  providers: [QualificationService, QualificationQueue, QualificationProcessor],
  exports: [QualificationService, QualificationQueue],
})
export class QualificationModule {}
