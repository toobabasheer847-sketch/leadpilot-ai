import { ConflictException, Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { DRIZZLE } from '../database/database.constants';
import type { Database } from '../database/database.types';
import { auditLogs, organizationMembers, organizations, users } from '../database/schema/schema';
import { OrganizationsService } from '../organizations/organizations.service';
import { UsersService } from '../users/users.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { AuthenticatedUser, JwtPayload } from './auth.types';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly usersService: UsersService,
    private readonly organizationsService: OrganizationsService,
    private readonly jwtService: JwtService,
  ) {}

  async register(dto: RegisterDto) {
    const email = this.normalizeEmail(dto.email);
    const passwordHash = await argon2.hash(dto.password, { type: argon2.argon2id });
    const slug = `${this.slugify(dto.organizationName)}-${randomUUID().slice(0, 8)}`;

    try {
      const result = await this.db.transaction(async (tx) => {
        const [existingUser] = await tx.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
        if (existingUser) {
          throw new ConflictException('Email is already registered');
        }

        const [organization] = await tx.insert(organizations).values({
          name: dto.organizationName.trim(),
          slug,
          status: 'ACTIVE',
        }).returning();

        const [user] = await tx.insert(users).values({
          name: dto.name.trim(),
          email,
          passwordHash,
          status: 'ACTIVE',
        }).returning();

        await tx.insert(organizationMembers).values({
          organizationId: organization.id,
          userId: user.id,
          role: 'OWNER',
        });

        await tx.insert(auditLogs).values({
          organizationId: organization.id,
          userId: user.id,
          action: 'registration',
          entityType: 'user',
          entityId: user.id,
          metadata: { role: 'OWNER' },
        });

        return { user, organization };
      });

      const authenticatedUser: AuthenticatedUser = {
        id: result.user.id,
        name: result.user.name,
        email: result.user.email,
        organizationId: result.organization.id,
        organizationName: result.organization.name,
        role: 'OWNER',
      };
      return this.withToken(authenticatedUser);
    } catch (error) {
      if (error instanceof ConflictException) {
        throw error;
      }
      if (this.isUniqueViolation(error)) {
        throw new ConflictException('Email is already registered');
      }
      throw error;
    }
  }

  async login(dto: LoginDto) {
    const email = this.normalizeEmail(dto.email);
    const user = await this.usersService.findByEmail(email);
    const validPassword = user ? await argon2.verify(user.passwordHash, dto.password).catch(() => false) : false;

    if (!user || !validPassword || user.status !== 'ACTIVE') {
      await this.recordAudit('failed_login', user?.id, undefined, { reason: 'invalid_credentials' });
      throw new UnauthorizedException('Invalid email or password');
    }

    const membership = (await this.organizationsService.findMembershipsForUser(user.id))[0];
    if (!membership || membership.organization.status !== 'ACTIVE') {
      await this.recordAudit('failed_login', user.id, undefined, { reason: 'inactive_membership' });
      throw new UnauthorizedException('Invalid email or password');
    }

    await this.recordAudit('successful_login', user.id, membership.organizationId);
    return this.withToken({
      id: user.id,
      name: user.name,
      email: user.email,
      organizationId: membership.organizationId,
      organizationName: membership.organization.name,
      role: membership.role,
    });
  }

  async me(user: AuthenticatedUser) {
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      organization: {
        id: user.organizationId,
        name: user.organizationName,
      },
      role: user.role,
    };
  }

  private withToken(user: AuthenticatedUser) {
    const payload: JwtPayload = {
      userId: user.id,
      organizationId: user.organizationId,
      role: user.role,
    };
    return {
      accessToken: this.jwtService.sign(payload),
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        organization: {
          id: user.organizationId,
          name: user.organizationName,
        },
        role: user.role,
      },
    };
  }

  private async recordAudit(action: string, userId?: string, organizationId?: string, metadata?: Record<string, string>) {
    try {
      await this.db.insert(auditLogs).values({
        action,
        entityType: 'auth',
        userId,
        organizationId,
        metadata,
      });
    } catch (error) {
      this.logger.warn(`Could not write auth audit event: ${error instanceof Error ? error.name : 'unknown error'}`);
    }
  }

  private normalizeEmail(email: string) {
    return email.trim().toLowerCase();
  }

  private slugify(value: string) {
    return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'organization';
  }

  private isUniqueViolation(error: unknown) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
  }
}
