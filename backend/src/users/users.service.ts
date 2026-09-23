import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE } from '../database/database.constants';
import type { Database } from '../database/database.types';
import { users } from '../database/schema/schema';

export type UserRecord = typeof users.$inferSelect;
export type PublicUser = Pick<UserRecord, 'id' | 'email' | 'name' | 'status'>;

@Injectable()
export class UsersService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async findById(id: string): Promise<UserRecord | undefined> {
    const [user] = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    return user;
  }

  async findByEmail(email: string): Promise<UserRecord | undefined> {
    const [user] = await this.db.select().from(users).where(eq(users.email, email)).limit(1);
    return user;
  }

  async createUser(data: { email: string; name: string; passwordHash: string }): Promise<PublicUser> {
    const [user] = await this.db.insert(users).values(data).returning({
      id: users.id,
      email: users.email,
      name: users.name,
      status: users.status,
    });
    return user;
  }

  async updateStatus(id: string, status: string): Promise<PublicUser | undefined> {
    const [user] = await this.db.update(users).set({ status, updatedAt: new Date() }).where(eq(users.id, id)).returning({
      id: users.id,
      email: users.email,
      name: users.name,
      status: users.status,
    });
    return user;
  }
}
