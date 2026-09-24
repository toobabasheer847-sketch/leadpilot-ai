import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/auth.decorators';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/auth.types';
import { ListUsageEventsDto } from './dto/list-usage-events.dto';
import { UsageService } from './usage.service';

@Controller('usage')
@UseGuards(JwtAuthGuard)
export class UsageController {
  constructor(private readonly usage: UsageService) {}
  @Get() summary(@CurrentUser() user: AuthenticatedUser) { return this.usage.summary(user); }
  @Get('events') history(@CurrentUser() user: AuthenticatedUser, @Query() filters: ListUsageEventsDto) { return this.usage.history(user, filters); }
}
