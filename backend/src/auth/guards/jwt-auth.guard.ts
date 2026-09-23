import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { OrganizationsService } from '../../organizations/organizations.service';
import { UsersService } from '../../users/users.service';
import { AuthenticatedRequest, JwtPayload } from '../auth.types';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly usersService: UsersService,
    private readonly organizationsService: OrganizationsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authorization = request.header('authorization');
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;

    if (!token) {
      throw new UnauthorizedException('Authentication required');
    }

    try {
      const payload = await this.jwtService.verifyAsync<JwtPayload>(token);
      const user = await this.usersService.findById(payload.userId);
      const membership = await this.organizationsService.findMembership(payload.userId, payload.organizationId);

      if (!user || user.status !== 'ACTIVE' || !membership || membership.organization.status !== 'ACTIVE') {
        throw new UnauthorizedException('Authentication required');
      }

      request.user = {
        id: user.id,
        email: user.email,
        name: user.name,
        organizationId: membership.organizationId,
        organizationName: membership.organization.name,
        role: membership.role,
      };
      return true;
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      throw new UnauthorizedException('Authentication required');
    }
  }
}
