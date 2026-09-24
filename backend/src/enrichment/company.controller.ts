import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/auth.decorators';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/auth.types';
import { EnrichmentService } from './enrichment.service';

@Controller('companies')
@UseGuards(JwtAuthGuard)
export class CompanyController {
  constructor(private readonly enrichmentService: EnrichmentService) {}

  @Post(':companyId/enrich')
  async enqueue(@Param('companyId') companyId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.enrichmentService.enqueueForCompany(companyId, user.organizationId);
  }

  @Get(':companyId')
  async findOne(@Param('companyId') companyId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.enrichmentService.getCompany(companyId, user.organizationId);
  }

  @Get(':companyId/evidence')
  async getEvidence(@Param('companyId') companyId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.enrichmentService.getEvidence(companyId, user.organizationId);
  }

  @Get(':companyId/social-profiles')
  async getSocialProfiles(@Param('companyId') companyId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.enrichmentService.getSocialProfiles(companyId, user.organizationId);
  }
}
