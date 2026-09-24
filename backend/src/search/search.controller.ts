import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/auth.decorators';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/auth.types';
import { CreateSearchDto } from './dto/create-search.dto';
import { ListSearchesDto } from './dto/list-searches.dto';
import { UpdateSearchDto } from './dto/update-search.dto';
import { PreviewSearchDto } from './dto/preview-search.dto';
import { SearchService } from './search.service';
import { UsageRateLimitGuard } from '../usage/usage-rate-limit.guard';

@Controller('searches')
@UseGuards(JwtAuthGuard, UsageRateLimitGuard)
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Post('preview')
  preview(@Body() body: PreviewSearchDto) {
    return this.searchService.preview(body.prompt);
  }

  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateSearchDto) {
    return this.searchService.create(user, dto);
  }

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Query() pagination: ListSearchesDto) {
    return this.searchService.list(user, pagination);
  }

  @Get('executions/:executionId')
  getExecution(@CurrentUser() user: AuthenticatedUser, @Param('executionId') executionId: string) {
    return this.searchService.getExecution(user, executionId);
  }

  @Get('executions/:executionId/candidates')
  listCandidates(@CurrentUser() user: AuthenticatedUser, @Param('executionId') executionId: string, @Query() pagination: ListSearchesDto) {
    return this.searchService.listCandidates(user, executionId, pagination.page, pagination.limit);
  }

  @Get(':searchId')
  findOne(@CurrentUser() user: AuthenticatedUser, @Param('searchId') searchId: string) {
    return this.searchService.findOne(user, searchId);
  }

  @Patch(':searchId')
  update(@CurrentUser() user: AuthenticatedUser, @Param('searchId') searchId: string, @Body() dto: UpdateSearchDto) {
    return this.searchService.update(user, searchId, dto);
  }

  @Get(':searchId/executions')
  listExecutions(@CurrentUser() user: AuthenticatedUser, @Param('searchId') searchId: string) {
    return this.searchService.listExecutions(user, searchId);
  }
}
