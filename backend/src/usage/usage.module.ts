import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { UsersModule } from '../users/users.module';
import { UsageController } from './usage.controller';
import { UsageRateLimitGuard } from './usage-rate-limit.guard';
import { UsageService } from './usage.service';
import { ProviderUsageService } from './provider-usage.service';

@Module({
  imports: [AuthModule, UsersModule, OrganizationsModule],
  controllers: [UsageController],
  providers: [UsageService, ProviderUsageService, UsageRateLimitGuard],
  exports: [UsageService, ProviderUsageService, UsageRateLimitGuard],
})
export class UsageModule {}
