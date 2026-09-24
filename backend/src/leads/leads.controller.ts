import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/auth.decorators';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/auth.types';
import { ListExecutionsDto } from './dto/list-executions.dto';
import { ListLeadsDto } from './dto/list-leads.dto';
import { LeadsService } from './leads.service';

@Controller()
@UseGuards(JwtAuthGuard)
export class LeadsController {
  constructor(private readonly service: LeadsService) {}

  @Get('leads')
  list(@CurrentUser() user: AuthenticatedUser, @Query() filters: ListLeadsDto) { return this.service.list(user, filters); }

  @Get('leads/:id')
  detail(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) { return this.service.detail(user, id); }

  @Get('leads/:id/review')
  review(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) { return this.service.review(user, id); }

  @Get('search-executions')
  executions(@CurrentUser() user: AuthenticatedUser, @Query() filters: ListExecutionsDto) { return this.service.listExecutions(user, filters); }

  @Get('search-executions/:id/leads')
  executionLeads(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Query() filters: ListLeadsDto) { return this.service.list(user, filters, id); }
}
