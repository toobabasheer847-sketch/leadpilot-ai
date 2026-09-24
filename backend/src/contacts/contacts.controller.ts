import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/auth.decorators';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/auth.types';
import { ContactsService } from './contacts.service';
import { UsageRateLimitGuard } from '../usage/usage-rate-limit.guard';

@Controller()
@UseGuards(JwtAuthGuard, UsageRateLimitGuard)
export class ContactsController {
  constructor(private readonly contactsService: ContactsService) {}

  @Post('companies/:companyId/contacts/discover')
  async discover(@Param('companyId') companyId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.contactsService.enqueueContactDiscovery(companyId, user.organizationId);
  }

  @Post('companies/:companyId/decision-makers/discover')
  async discoverDecisionMakers(@Param('companyId') companyId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.contactsService.enqueueContactDiscovery(companyId, user.organizationId);
  }

  @Get('companies/:companyId/contacts')
  async list(@Param('companyId') companyId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.contactsService.listForCompany(companyId, user.organizationId);
  }

  @Get('companies/:companyId/decision-makers')
  async listDecisionMakers(@Param('companyId') companyId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.contactsService.listForCompany(companyId, user.organizationId);
  }

  @Get('contacts/:contactId')
  async findOne(@Param('contactId') contactId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.contactsService.findById(contactId, user.organizationId);
  }

  @Get('contacts/:contactId/evidence')
  async evidence(@Param('contactId') contactId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.contactsService.listEvidence(contactId, user.organizationId);
  }
}
