import { Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/auth.decorators';
import type { AuthenticatedUser } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { UsageRateLimitGuard } from '../usage/usage-rate-limit.guard';
import { ResearchService } from './research.service';

@Controller('companies')
@UseGuards(JwtAuthGuard, UsageRateLimitGuard)
export class ResearchController {
  constructor(private readonly research: ResearchService) {}

  @Post(':companyId/research')
  @HttpCode(202)
  start(@Param('companyId') companyId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.research.start(companyId, user.organizationId);
  }

  @Get(':companyId/research')
  list(@Param('companyId') companyId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.research.list(companyId, user.organizationId);
  }

  @Get(':companyId/research/:researchExecutionId')
  get(@Param('companyId') companyId: string, @Param('researchExecutionId') researchExecutionId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.research.get(companyId, researchExecutionId, user.organizationId);
  }
}
