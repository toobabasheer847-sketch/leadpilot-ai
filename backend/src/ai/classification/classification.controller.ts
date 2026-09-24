import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../auth/auth.decorators';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { ClassifyCompanyDto } from './dto/classify-company.dto';
import { ClassificationService, mergeCriteria } from './classification.service';
import { UsageRateLimitGuard } from '../../usage/usage-rate-limit.guard';

@Controller()
@UseGuards(JwtAuthGuard, UsageRateLimitGuard)
export class ClassificationController {
  constructor(private readonly service: ClassificationService) {}

  @Post('companies/:companyId/classify')
  classify(@Param('companyId') companyId: string, @Query('force') force: string | undefined, @Body() dto: ClassifyCompanyDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.enqueue(companyId, user.organizationId, mergeCriteria(dto), null, force === 'true');
  }

  @Get('companies/:companyId/classification')
  latest(@Param('companyId') companyId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.getLatest(companyId, user.organizationId);
  }

  @Post('companies/:companyId/classification/retry')
  retry(@Param('companyId') companyId: string, @Body() dto: ClassifyCompanyDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.retry(companyId, user.organizationId, mergeCriteria(dto), null);
  }

  @Get('classifications/:classificationId')
  byId(@Param('classificationId') classificationId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.getById(classificationId, user.organizationId);
  }
}
