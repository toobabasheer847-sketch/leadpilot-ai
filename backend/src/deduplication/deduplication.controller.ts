import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/auth.decorators';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/auth.types';
import { MergeDuplicateDto } from './dto/merge-duplicate.dto';
import { ReviewDuplicateDto } from './dto/review-duplicate.dto';
import { DeduplicationService } from './deduplication.service';

@Controller()
@UseGuards(JwtAuthGuard)
export class DeduplicationController {
  constructor(private readonly service: DeduplicationService) {}

  @Post('companies/:companyId/deduplicate')
  deduplicateCompany(@Param('companyId') companyId: string, @CurrentUser() user: AuthenticatedUser) { return this.service.enqueueCompany(companyId, user.organizationId); }

  @Post('contacts/:contactId/deduplicate')
  deduplicateContact(@Param('contactId') contactId: string, @CurrentUser() user: AuthenticatedUser) { return this.service.enqueueContact(contactId, user.organizationId); }

  @Get('duplicates')
  list(@CurrentUser() user: AuthenticatedUser) { return this.service.list(user.organizationId); }

  @Get('duplicates/:id')
  get(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) { return this.service.getDuplicate(id, user.organizationId); }

  @Get('duplicate-groups/:id')
  group(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) { return this.service.getGroup(id, user.organizationId); }

  @Post('duplicates/:id/review')
  review(@Param('id') id: string, @Body() dto: ReviewDuplicateDto, @CurrentUser() user: AuthenticatedUser) { return this.service.review(id, user.organizationId, user.id, dto.decision, dto.reason); }

  @Post('duplicate-groups/:id/merge')
  merge(@Param('id') id: string, @Body() dto: MergeDuplicateDto, @CurrentUser() user: AuthenticatedUser) { return this.service.mergeGroup(id, user.organizationId, dto.canonicalEntityId); }

  @Post('duplicate-groups/:id/reject')
  reject(@Param('id') id: string, @Body() dto: ReviewDuplicateDto, @CurrentUser() user: AuthenticatedUser) { return this.service.rejectGroup(id, user.organizationId, user.id, dto.reason); }
}
