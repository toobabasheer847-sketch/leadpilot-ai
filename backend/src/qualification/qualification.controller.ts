import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/auth.decorators';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/auth.types';
import { UsageRateLimitGuard } from '../usage/usage-rate-limit.guard';
import { QualifyExecutionDto } from './dto/qualify-execution.dto';
import { QualificationService } from './qualification.service';

@Controller()
@UseGuards(JwtAuthGuard, UsageRateLimitGuard)
export class QualificationController {
  constructor(private readonly service: QualificationService) {}

  @Post('search-executions/:executionId/qualify')
  qualify(@Param('executionId') executionId: string, @Body() dto: QualifyExecutionDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.enqueueExecution(executionId, user.organizationId, dto.force ?? false);
  }

  @Get('search-executions/:executionId/qualifications')
  list(@Param('executionId') executionId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.listForExecution(executionId, user.organizationId);
  }
}
