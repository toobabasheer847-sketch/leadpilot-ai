import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { DRIZZLE } from './database.constants';

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private closed = false;

  constructor(
    @Inject(DRIZZLE) private readonly db: NodePgDatabase,
  ) {}

  async ping(): Promise<void> {
    await this.db.execute(sql`select 1`);
  }

  /** Ends the Postgres pool so idle sockets and in-flight work cannot outlive shutdown. */
  async closePool() {
    if (this.closed) return;
    this.closed = true;
    const pool = (this.db as { $client?: { end?: () => Promise<void> } }).$client;
    if (!pool?.end) return;
    await Promise.race([
      pool.end(),
      new Promise((resolve) => setTimeout(resolve, 3_000)),
    ]);
  }

  async onModuleDestroy() {
    await this.closePool();
  }
}
