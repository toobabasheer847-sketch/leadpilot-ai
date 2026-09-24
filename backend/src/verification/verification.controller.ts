import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/auth.decorators';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/auth.types';
import { VerifyLeadDto } from './dto/verify-lead.dto';
import { VerificationService } from './verification.service';
import { UsageRateLimitGuard } from '../usage/usage-rate-limit.guard';

@Controller()
@UseGuards(JwtAuthGuard, UsageRateLimitGuard)
export class VerificationController {
  constructor(private readonly service: VerificationService) {}

  @Get('companies/:companyId/verifications')
  listCompany(@Param('companyId') companyId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.listCompany(companyId, user.organizationId);
  }

  @Get('contacts/:contactId/verifications')
  listContact(@Param('contactId') contactId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.listContact(contactId, user.organizationId);
  }

  @Post('companies/:companyId/verify')
  verifyCompany(@Param('companyId') companyId: string, @Body() dto: VerifyLeadDto, @Query('force') force: string | undefined, @CurrentUser() user: AuthenticatedUser) {
    return this.service.enqueueCompany(companyId, user.organizationId, dto.force ?? force === 'true');
  }

  @Post('companies/:companyId/verification')
  verifyCompanyAlias(@Param('companyId') companyId: string, @Body() dto: VerifyLeadDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.enqueueCompany(companyId, user.organizationId, dto.force ?? false);
  }

  @Get('companies/:companyId/verification')
  verificationSummary(@Param('companyId') companyId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.summaryCompany(companyId, user.organizationId);
  }

  @Post('contacts/:contactId/verify')
  verifyContact(@Param('contactId') contactId: string, @Body() dto: VerifyLeadDto, @Query('force') force: string | undefined, @CurrentUser() user: AuthenticatedUser) {
    return this.service.enqueueContact(contactId, user.organizationId, dto.force ?? force === 'true');
  }

  @Get('verifications/:verificationId')
  getById(@Param('verificationId') verificationId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.getById(verificationId, user.organizationId);
  }
}
