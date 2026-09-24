import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { UsersModule } from '../users/users.module';
import { LeadsModule } from '../leads/leads.module';
import { UsageModule } from '../usage/usage.module';
import { ExportFormatService } from './export-format.service';
import { ExportStorageService } from './export-storage.service';
import { ExportsController } from './exports.controller';
import { ExportsProcessor } from './exports.processor';
import { ExportsQueue } from './exports.queue';
import { ExportsService } from './exports.service';

@Module({
  imports: [ConfigModule, AuthModule, UsersModule, OrganizationsModule, LeadsModule, UsageModule, BullModule.registerQueue({ name: 'lead-export-queue' })],
  controllers: [ExportsController],
  providers: [ExportsService, ExportsQueue, ExportsProcessor, ExportFormatService, ExportStorageService],
  exports: [ExportsService, ExportsQueue],
})
export class ExportsModule {}
