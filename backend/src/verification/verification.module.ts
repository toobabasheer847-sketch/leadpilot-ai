import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { UsersModule } from '../users/users.module';
import { VerificationController } from './verification.controller';
import { VerificationProcessor } from './verification.processor';
import { VerificationQueue } from './verification.queue';
import { VerificationService } from './verification.service';
import { EmailVerificationProvider } from './providers/email/email-verification.provider';
import { PhoneVerificationProvider } from './providers/phone/phone-verification.provider';
import { WebsiteVerificationProvider } from './providers/website/website-verification.provider';
import { SocialVerificationProvider } from './providers/social/social-verification.provider';
import {
  EMAIL_VERIFICATION_PROVIDER,
  PHONE_VERIFICATION_PROVIDER,
  SOCIAL_VERIFICATION_PROVIDER,
  WEBSITE_VERIFICATION_PROVIDER,
} from './providers/verification-provider.interface';

@Module({
  imports: [ConfigModule, AuthModule, UsersModule, OrganizationsModule, BullModule.registerQueue({ name: 'lead-verification-queue' })],
  controllers: [VerificationController],
  providers: [
    VerificationService,
    VerificationQueue,
    VerificationProcessor,
    EmailVerificationProvider,
    PhoneVerificationProvider,
    WebsiteVerificationProvider,
    SocialVerificationProvider,
    { provide: EMAIL_VERIFICATION_PROVIDER, useExisting: EmailVerificationProvider },
    { provide: PHONE_VERIFICATION_PROVIDER, useExisting: PhoneVerificationProvider },
    { provide: WEBSITE_VERIFICATION_PROVIDER, useExisting: WebsiteVerificationProvider },
    { provide: SOCIAL_VERIFICATION_PROVIDER, useExisting: SocialVerificationProvider },
  ],
  exports: [VerificationService, VerificationQueue],
})
export class VerificationModule {}
