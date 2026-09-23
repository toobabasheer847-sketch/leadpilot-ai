import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DRIZZLE } from '../../database/database.constants';
import type { Database } from '../../database/database.types';
import { searchConfigurations } from '../../database/schema/schema';

@Injectable()
export class SearchConfigurationRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async create(data: typeof searchConfigurations.$inferInsert) {
    const [search] = await this.db.insert(searchConfigurations).values(data).returning();
    return search;
  }

  async findByIdForOrganization(id: string, organizationId: string) {
    const [search] = await this.db.select().from(searchConfigurations).where(and(
      eq(searchConfigurations.id, id),
      eq(searchConfigurations.organizationId, organizationId),
    )).limit(1);
    return search;
  }

  async listForOrganization(organizationId: string, page: number, limit: number) {
    const offset = (page - 1) * limit;
    const [items, count] = await Promise.all([
      this.db.select().from(searchConfigurations)
        .where(eq(searchConfigurations.organizationId, organizationId))
        .orderBy(desc(searchConfigurations.createdAt))
        .limit(limit)
        .offset(offset),
      this.db.select({ count: sql<number>`count(*)::int` }).from(searchConfigurations)
        .where(eq(searchConfigurations.organizationId, organizationId)),
    ]);
    return { items, total: count[0]?.count ?? 0, page, limit };
  }

  async updateForOrganization(id: string, organizationId: string, data: Partial<typeof searchConfigurations.$inferInsert>) {
    const [search] = await this.db.update(searchConfigurations)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(searchConfigurations.id, id), eq(searchConfigurations.organizationId, organizationId)))
      .returning();
    return search;
  }
}
