import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { UsageService } from './usage.service';

@Injectable()
export class UsageRateLimitGuard implements CanActivate {
  constructor(private readonly usage: UsageService) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.user;
    if (user) await this.usage.checkRequestRate(user.organizationId, user.id, this.operation(request.path));
    return true;
  }

  private operation(path: string) {
    if (path.includes('/exports')) return 'EXPORT' as const;
    if (path.includes('/classif')) return 'AI_CLASSIFICATION' as const;
    if (path.includes('/search')) return 'SEARCH' as const;
    return 'DISCOVERY' as const;
  }
}
