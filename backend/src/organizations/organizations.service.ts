import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE } from '../database/database.constants';
import type { Database } from '../database/database.types';
import { organizationMembers, organizations } from '../database/schema/schema';

@Injectable()
export class OrganizationsService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async createOrganization(data: { name: string; slug: string }) {
    const [organization] = await this.db.insert(organizations).values(data).returning();
    return organization;
  }

  async createMembership(data: { organizationId: string; userId: string; role: string }) {
    const [membership] = await this.db.insert(organizationMembers).values(data).returning();
    return membership;
  }

  async findById(id: string) {
    const [organization] = await this.db.select().from(organizations).where(eq(organizations.id, id)).limit(1);
    return organization;
  }

  async findMembership(userId: string, organizationId: string) {
    const [membership] = await this.db.select({
      id: organizationMembers.id,
      organizationId: organizationMembers.organizationId,
      userId: organizationMembers.userId,
      role: organizationMembers.role,
      organization: organizations,
    }).from(organizationMembers)
      .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
      .where(and(
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.organizationId, organizationId),
      ))
      .limit(1);
    return membership;
  }

  async findMembershipsForUser(userId: string) {
    return this.db.select({
      id: organizationMembers.id,
      organizationId: organizationMembers.organizationId,
      userId: organizationMembers.userId,
      role: organizationMembers.role,
      organization: organizations,
    }).from(organizationMembers)
      .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
      .where(eq(organizationMembers.userId, userId));
  }
}
