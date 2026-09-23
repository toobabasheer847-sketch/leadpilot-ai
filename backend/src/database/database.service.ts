import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { DRIZZLE } from './database.constants';

@Injectable()
export class DatabaseService {
  constructor(
    @Inject(DRIZZLE) private readonly db: NodePgDatabase,
  ) {}

  async ping(): Promise<void> {
    await this.db.execute(sql`select 1`);
  }
}
