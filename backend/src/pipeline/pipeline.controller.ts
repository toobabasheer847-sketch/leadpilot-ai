import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/auth.decorators';
import type { AuthenticatedUser } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { UsageRateLimitGuard } from '../usage/usage-rate-limit.guard';
import { PipelineService } from './pipeline.service';

@Controller()
@UseGuards(JwtAuthGuard, UsageRateLimitGuard)
export class PipelineController {
  constructor(private readonly pipelines: PipelineService) {}

  @Post('searches/:searchId/execute')
  execute(@CurrentUser() user: AuthenticatedUser, @Param('searchId') searchId: string) {
    return this.pipelines.start(user, searchId);
  }

  @Post('searches/:searchId/pipeline')
  start(@CurrentUser() user: AuthenticatedUser, @Param('searchId') searchId: string) {
    return this.pipelines.start(user, searchId);
  }

  @Get('searches/:searchId/pipeline')
  status(@CurrentUser() user: AuthenticatedUser, @Param('searchId') searchId: string) {
    return this.pipelines.getForSearch(user, searchId);
  }

  @Get('search-executions/:executionId')
  execution(@CurrentUser() user: AuthenticatedUser, @Param('executionId') executionId: string) {
    return this.pipelines.getByExecution(user, executionId);
  }

  @Post('search-executions/:executionId/cancel')
  cancelExecution(@CurrentUser() user: AuthenticatedUser, @Param('executionId') executionId: string) {
    return this.pipelines.cancelByExecution(user, executionId);
  }

  @Post('pipeline/:pipelineExecutionId/cancel')
  cancel(@CurrentUser() user: AuthenticatedUser, @Param('pipelineExecutionId') pipelineExecutionId: string) {
    return this.pipelines.cancel(user, pipelineExecutionId);
  }
}
