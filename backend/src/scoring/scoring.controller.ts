import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/auth.decorators';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/auth.types';
import { CalculateScoreDto } from './dto/calculate-score.dto';
import { ScoringService } from './scoring.service';

@Controller()
@UseGuards(JwtAuthGuard)
export class ScoringController {
  constructor(private readonly service: ScoringService) {}

  @Post('companies/:companyId/score')
  scoreCompany(@Param('companyId') companyId: string, @Body() dto: CalculateScoreDto, @Query('force') force: string | undefined, @CurrentUser() user: AuthenticatedUser) {
    return this.service.enqueueCompany(companyId, user.organizationId, dto.force ?? force === 'true');
  }

  @Post('contacts/:contactId/score')
  scoreContact(@Param('contactId') contactId: string, @Body() dto: CalculateScoreDto, @Query('force') force: string | undefined, @CurrentUser() user: AuthenticatedUser) {
    return this.service.enqueueContact(contactId, user.organizationId, dto.force ?? force === 'true');
  }

  @Get('companies/:companyId/score')
  getCompanyScore(@Param('companyId') companyId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.getCompany(companyId, user.organizationId);
  }

  @Get('contacts/:contactId/score')
  getContactScore(@Param('contactId') contactId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.getContact(contactId, user.organizationId);
  }
}
