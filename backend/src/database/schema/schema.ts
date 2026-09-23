import { pgTable, uuid, varchar, text, integer, timestamp, jsonb } from 'drizzle-orm/pg-core';

export const searchCampaigns = pgTable('search_campaigns', {
  id: uuid('id').defaultRandom().primaryKey(),
  userPrompt: text('user_prompt').notNull(),
  structuredPlan: jsonb('structured_plan'),
  status: varchar('status', { length: 50 }).default('PENDING').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});