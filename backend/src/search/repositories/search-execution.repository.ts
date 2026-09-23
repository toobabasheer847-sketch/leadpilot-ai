import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { DRIZZLE } from '../../database/database.constants';
import type { Database } from '../../database/database.types';
import { searchExecutions } from '../../database/schema/schema';

@Injectable()
export class SearchExecutionRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async findByIdForOrganization(id: string, organizationId: string) {
    const [execution] = await this.db.select().from(searchExecutions).where(and(
      eq(searchExecutions.id, id),
      eq(searchExecutions.organizationId, organizationId),
    )).limit(1);
    return execution;
  }

  async listForSearch(searchConfigurationId: string, organizationId: string) {
    return this.db.select().from(searchExecutions).where(and(
      eq(searchExecutions.searchConfigurationId, searchConfigurationId),
      eq(searchExecutions.organizationId, organizationId),
    )).orderBy(desc(searchExecutions.createdAt));
  }
}
