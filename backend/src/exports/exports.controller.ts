import { Body, Controller, Get, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../auth/auth.decorators';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/auth.types';
import { CreateExportDto } from './dto/create-export.dto';
import { ListExportsDto } from './dto/list-exports.dto';
import { ExportsService } from './exports.service';

@Controller('exports')
@UseGuards(JwtAuthGuard)
export class ExportsController {
  constructor(private readonly service: ExportsService) {}

  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateExportDto) { return this.service.create(user, dto); }

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Query() filters: ListExportsDto) { return this.service.list(user, filters); }

  @Get(':id/download')
  async download(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser, @Res() response: Response) {
    const result = await this.service.download(id, user.organizationId);
    response.setHeader('Content-Type', result.record.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    response.setHeader('Content-Disposition', `attachment; filename="${result.record.fileName}"`);
    response.send(result.content);
  }

  @Get(':id')
  get(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) { return this.service.get(id, user.organizationId); }
}
