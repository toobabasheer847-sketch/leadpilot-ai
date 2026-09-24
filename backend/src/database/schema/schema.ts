import { relations, sql } from 'drizzle-orm';
import {
  check,
  boolean,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  index,
} from 'drizzle-orm/pg-core';

export const searchCampaigns = pgTable('search_campaigns', {
  id: uuid('id').defaultRandom().primaryKey(),
  userPrompt: text('user_prompt').notNull(),
  structuredPlan: jsonb('structured_plan'),
  status: varchar('status', { length: 50 }).default('PENDING').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
};

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: varchar('email', { length: 320 }).notNull(),
  name: varchar('name', { length: 255 }),
  passwordHash: text('password_hash').notNull(),
  status: varchar('status', { length: 50 }).default('ACTIVE').notNull(),
  ...timestamps,
}, (table) => [uniqueIndex('users_email_unique').on(table.email), index('users_status_idx').on(table.status)]);

export const organizations = pgTable('organizations', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  slug: varchar('slug', { length: 255 }).notNull(),
  status: varchar('status', { length: 50 }).default('ACTIVE').notNull(),
  ...timestamps,
}, (table) => [uniqueIndex('organizations_slug_unique').on(table.slug), index('organizations_status_idx').on(table.status)]);

export const organizationMembers = pgTable('organization_members', {
  id: uuid('id').defaultRandom().primaryKey(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'restrict' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  role: varchar('role', { length: 50 }).default('MEMBER').notNull(),
  ...timestamps,
}, (table) => [
  uniqueIndex('organization_members_org_user_unique').on(table.organizationId, table.userId),
  index('organization_members_user_idx').on(table.userId),
  index('organization_members_org_idx').on(table.organizationId),
]);

export const searchConfigurations = pgTable('search_configurations', {
  id: uuid('id').defaultRandom().primaryKey(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'restrict' }),
  createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  name: varchar('name', { length: 255 }).notNull(),
  originalPrompt: text('original_prompt'),
  criteria: jsonb('criteria'),
  status: varchar('status', { length: 50 }).default('DRAFT').notNull(),
  ...timestamps,
}, (table) => [
  index('search_configurations_org_idx').on(table.organizationId),
  index('search_configurations_created_by_idx').on(table.createdByUserId),
  index('search_configurations_status_idx').on(table.status),
]);

export const searchExecutions = pgTable('search_executions', {
  id: uuid('id').defaultRandom().primaryKey(),
  searchConfigurationId: uuid('search_configuration_id').notNull().references(() => searchConfigurations.id, { onDelete: 'restrict' }),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'restrict' }),
  status: varchar('status', { length: 50 }).default('PENDING').notNull(),
  structuredPlan: jsonb('structured_plan'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  totalCandidates: integer('total_candidates').default(0).notNull(),
  totalLeads: integer('total_leads').default(0).notNull(),
  errorMessage: text('error_message'),
  ...timestamps,
}, (table) => [
  index('search_executions_org_idx').on(table.organizationId),
  index('search_executions_config_idx').on(table.searchConfigurationId),
  index('search_executions_status_idx').on(table.status),
  index('search_executions_created_at_idx').on(table.createdAt),
]);

export const companies = pgTable('companies', {
  id: uuid('id').defaultRandom().primaryKey(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'restrict' }),
  name: varchar('name', { length: 255 }).notNull(),
  legalName: varchar('legal_name', { length: 255 }),
  website: text('website'),
  description: text('description'),
  category: varchar('category', { length: 100 }),
  investorType: varchar('investor_type', { length: 100 }),
  phone: varchar('phone', { length: 50 }),
  email: varchar('email', { length: 320 }),
  employeeCount: integer('employee_count'),
  employeeRange: varchar('employee_range', { length: 50 }),
  investmentStrategy: text('investment_strategy'),
  marketsServed: jsonb('markets_served'),
  propertyTypes: jsonb('property_types'),
  googlePlaceId: varchar('google_place_id', { length: 255 }),
  googleMapsUrl: text('google_maps_url'),
  canonicalCompanyId: uuid('canonical_company_id'),
  verificationStatus: varchar('verification_status', { length: 50 }).default('NOT_VERIFIED').notNull(),
  lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
  ...timestamps,
}, (table) => [
  index('companies_org_idx').on(table.organizationId),
  index('companies_name_idx').on(table.name),
  index('companies_verification_status_idx').on(table.verificationStatus),
  uniqueIndex('companies_org_place_unique').on(table.organizationId, table.googlePlaceId),
]);

export const companyLocations = pgTable('company_locations', {
  id: uuid('id').defaultRandom().primaryKey(),
  companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'restrict' }),
  addressLine1: varchar('address_line_1', { length: 255 }),
  addressLine2: varchar('address_line_2', { length: 255 }),
  city: varchar('city', { length: 120 }),
  state: varchar('state', { length: 100 }),
  postalCode: varchar('postal_code', { length: 20 }),
  country: varchar('country', { length: 2 }),
  latitude: numeric('latitude', { precision: 10, scale: 7 }),
  longitude: numeric('longitude', { precision: 10, scale: 7 }),
  isPrimary: boolean('is_primary').default(false).notNull(),
  ...timestamps,
}, (table) => [
  index('company_locations_company_idx').on(table.companyId),
  index('company_locations_state_idx').on(table.state),
  index('company_locations_city_idx').on(table.city),
  index('company_locations_postal_code_idx').on(table.postalCode),
]);

export const companyContacts = pgTable('company_contacts', {
  id: uuid('id').defaultRandom().primaryKey(),
  companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'restrict' }),
  firstName: varchar('first_name', { length: 120 }),
  lastName: varchar('last_name', { length: 120 }),
  fullName: varchar('full_name', { length: 255 }),
  title: varchar('title', { length: 255 }),
  email: varchar('email', { length: 320 }),
  phone: varchar('phone', { length: 50 }),
  linkedinUrl: text('linkedin_url'),
  facebookUrl: text('facebook_url'),
  instagramUrl: text('instagram_url'),
  canonicalContactId: uuid('canonical_contact_id'),
  source: text('source'),
  status: varchar('status', { length: 50 }).default('DISCOVERED').notNull(),
  confidence: numeric('confidence', { precision: 5, scale: 4 }),
  identityConfidence: numeric('identity_confidence', { precision: 5, scale: 4 }),
  identityEvidence: jsonb('identity_evidence'),
  verificationStatus: varchar('verification_status', { length: 50 }).default('NOT_VERIFIED').notNull(),
  lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
  ...timestamps,
}, (table) => [index('company_contacts_company_idx').on(table.companyId), index('company_contacts_verification_status_idx').on(table.verificationStatus), index('company_contacts_status_idx').on(table.status)]);

export const companySocialProfiles = pgTable('company_social_profiles', {
  id: uuid('id').defaultRandom().primaryKey(),
  companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'restrict' }),
  platform: varchar('platform', { length: 50 }).notNull(),
  profileUrl: text('profile_url').notNull(),
  username: varchar('username', { length: 255 }),
  verificationStatus: varchar('verification_status', { length: 50 }).default('NOT_VERIFIED').notNull(),
  lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
  ...timestamps,
}, (table) => [
  uniqueIndex('company_social_profiles_unique').on(table.companyId, table.platform, table.profileUrl),
  index('company_social_profiles_company_idx').on(table.companyId),
]);

export const sourceRecords = pgTable('source_records', {
  id: uuid('id').defaultRandom().primaryKey(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'restrict' }),
  searchExecutionId: uuid('search_execution_id').notNull().references(() => searchExecutions.id, { onDelete: 'restrict' }),
  companyId: uuid('company_id').references(() => companies.id, { onDelete: 'set null' }),
  sourceType: varchar('source_type', { length: 100 }).notNull(),
  sourceName: varchar('source_name', { length: 255 }),
  sourceUrl: text('source_url').notNull(),
  externalId: varchar('external_id', { length: 255 }),
  requestId: varchar('request_id', { length: 255 }),
  correlationId: varchar('correlation_id', { length: 255 }),
  rawData: jsonb('raw_data'),
  retrievedAt: timestamp('retrieved_at', { withTimezone: true }).defaultNow().notNull(),
  ...timestamps,
}, (table) => [
  index('source_records_execution_idx').on(table.searchExecutionId),
  index('source_records_company_idx').on(table.companyId),
  index('source_records_type_idx').on(table.sourceType),
  index('source_records_url_idx').on(table.sourceUrl),
  uniqueIndex('source_records_execution_provider_external_unique').on(table.organizationId, table.searchExecutionId, table.sourceType, table.externalId),
]);

export const leadEvidence = pgTable('lead_evidence', {
  id: uuid('id').defaultRandom().primaryKey(),
  companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'restrict' }),
  contactId: uuid('contact_id').references(() => companyContacts.id, { onDelete: 'set null' }),
  sourceRecordId: uuid('source_record_id').references(() => sourceRecords.id, { onDelete: 'set null' }),
  evidenceType: varchar('evidence_type', { length: 100 }).notNull(),
  sourceUrl: text('source_url').notNull(),
  evidenceText: text('evidence_text').notNull(),
  evidenceTimestamp: timestamp('evidence_timestamp', { withTimezone: true }),
  metadata: jsonb('metadata'),
  ...timestamps,
}, (table) => [index('lead_evidence_company_idx').on(table.companyId), index('lead_evidence_source_record_idx').on(table.sourceRecordId)]);

export const leadClassifications = pgTable('lead_classifications', {
  id: uuid('id').defaultRandom().primaryKey(),
  companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'restrict' }),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'restrict' }),
  searchExecutionId: uuid('search_execution_id').references(() => searchExecutions.id, { onDelete: 'set null' }),
  category: varchar('category', { length: 100 }).notNull().default('REAL_ESTATE_INVESTOR'),
  investorType: varchar('investor_type', { length: 100 }).notNull().default('NOT_DETERMINED'),
  classification: varchar('classification', { length: 100 }).notNull(),
  decision: varchar('decision', { length: 50 }).notNull(),
  confidence: numeric('confidence', { precision: 5, scale: 4 }),
  reasoning: text('reasoning').notNull(),
  modelName: varchar('model_name', { length: 255 }),
  promptVersion: varchar('prompt_version', { length: 100 }).notNull().default('investor-classifier-v1'),
  reasons: jsonb('reasons').notNull().default([]),
  positiveEvidence: jsonb('positive_evidence').notNull().default([]),
  negativeEvidence: jsonb('negative_evidence').notNull().default([]),
  missingEvidence: jsonb('missing_evidence').notNull().default([]),
  exclusionReason: text('exclusion_reason'),
  companySizeVerification: varchar('company_size_verification', { length: 30 }).notNull().default('NOT_FOUND'),
  locationStatus: varchar('location_status', { length: 30 }).notNull().default('NOT_FOUND'),
  idempotencyKey: varchar('idempotency_key', { length: 512 }).notNull(),
  evidenceSummary: text('evidence_summary'),
  ...timestamps,
}, (table) => [
  index('lead_classifications_company_idx').on(table.companyId),
  index('lead_classifications_org_idx').on(table.organizationId),
  index('lead_classifications_execution_idx').on(table.searchExecutionId),
  index('lead_classifications_decision_idx').on(table.decision),
  uniqueIndex('lead_classifications_idempotency_unique').on(table.organizationId, table.idempotencyKey),
  check('lead_classifications_confidence_check', sql`${table.confidence} is null or (${table.confidence} >= 0 and ${table.confidence} <= 1)`),
] );

export const leadVerifications = pgTable('lead_verifications', {
  id: uuid('id').defaultRandom().primaryKey(),
  companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'restrict' }),
  contactId: uuid('contact_id').references(() => companyContacts.id, { onDelete: 'set null' }),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'restrict' }),
  fieldName: varchar('field_name', { length: 100 }).notNull(),
  field: varchar('field', { length: 100 }).notNull().default('unknown'),
  fieldValue: text('field_value'),
  verificationStatus: varchar('verification_status', { length: 50 }).notNull(),
  status: varchar('status', { length: 50 }).notNull().default('NOT_FOUND'),
  verificationType: varchar('verification_type', { length: 50 }).notNull().default('SOURCE_EVIDENCE'),
  provider: varchar('provider', { length: 100 }),
  evidenceId: uuid('evidence_id').references(() => leadEvidence.id, { onDelete: 'set null' }),
  confidence: numeric('confidence', { precision: 5, scale: 4 }),
  checkedAt: timestamp('checked_at', { withTimezone: true }).defaultNow().notNull(),
  metadata: jsonb('metadata'),
  idempotencyKey: varchar('idempotency_key', { length: 512 }).notNull().default('legacy'),
  verificationSource: varchar('verification_source', { length: 255 }),
  verificationUrl: text('verification_url'),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  notes: text('notes'),
  ...timestamps,
}, (table) => [
  index('lead_verifications_company_idx').on(table.companyId),
  index('lead_verifications_contact_idx').on(table.contactId),
  index('lead_verifications_status_idx').on(table.verificationStatus),
  index('lead_verifications_org_idx').on(table.organizationId),
  uniqueIndex('lead_verifications_idempotency_unique').on(table.organizationId, table.idempotencyKey),
]);

export const leadScores = pgTable('lead_scores', {
  id: uuid('id').defaultRandom().primaryKey(),
  companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'restrict' }),
  contactId: uuid('contact_id').references(() => companyContacts.id, { onDelete: 'set null' }),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'restrict' }),
  searchExecutionId: uuid('search_execution_id').references(() => searchExecutions.id, { onDelete: 'set null' }),
  score: integer('score').notNull(),
  band: varchar('band', { length: 20 }).notNull(),
  version: varchar('version', { length: 30 }).notNull(),
  breakdown: jsonb('breakdown').notNull(),
  idempotencyKey: varchar('idempotency_key', { length: 512 }).notNull(),
  calculatedAt: timestamp('calculated_at', { withTimezone: true }).defaultNow().notNull(),
  ...timestamps,
}, (table) => [
  index('lead_scores_company_idx').on(table.companyId),
  index('lead_scores_contact_idx').on(table.contactId),
  index('lead_scores_org_idx').on(table.organizationId),
  index('lead_scores_score_idx').on(table.score),
  uniqueIndex('lead_scores_idempotency_unique').on(table.organizationId, table.idempotencyKey),
  check('lead_scores_score_check', sql`${table.score} >= 0 and ${table.score} <= 100`),
]);

export const leadDuplicates = pgTable('lead_duplicates', {
  id: uuid('id').defaultRandom().primaryKey(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'restrict' }),
  entityType: varchar('entity_type', { length: 20 }).notNull().default('COMPANY'),
  entityAId: uuid('entity_a_id').notNull(),
  entityBId: uuid('entity_b_id').notNull(),
  groupId: uuid('group_id'),
  companyId: uuid('company_id').references(() => companies.id, { onDelete: 'restrict' }),
  duplicateCompanyId: uuid('duplicate_company_id').references(() => companies.id, { onDelete: 'restrict' }),
  matchType: varchar('match_type', { length: 50 }).notNull(),
  confidence: numeric('confidence', { precision: 5, scale: 4 }),
  status: varchar('status', { length: 50 }).default('PENDING').notNull(),
  signals: jsonb('signals').notNull().default([]),
  reason: text('reason'),
  reviewedBy: uuid('reviewed_by').references(() => users.id, { onDelete: 'set null' }),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  reviewedReason: text('reviewed_reason'),
  ...timestamps,
}, (table) => [
  uniqueIndex('lead_duplicates_pair_unique').on(table.organizationId, table.entityType, table.entityAId, table.entityBId),
  index('lead_duplicates_org_idx').on(table.organizationId),
  index('lead_duplicates_group_idx').on(table.groupId),
  index('lead_duplicates_entity_a_idx').on(table.entityAId),
  index('lead_duplicates_entity_b_idx').on(table.entityBId),
  index('lead_duplicates_company_idx').on(table.companyId),
  index('lead_duplicates_duplicate_company_idx').on(table.duplicateCompanyId),
  check('lead_duplicates_not_self_check', sql`${table.entityAId} <> ${table.entityBId}`),
]);

export const duplicateGroups = pgTable('duplicate_groups', {
  id: uuid('id').defaultRandom().primaryKey(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'restrict' }),
  entityType: varchar('entity_type', { length: 20 }).notNull(),
  canonicalEntityId: uuid('canonical_entity_id').notNull(),
  status: varchar('status', { length: 50 }).default('PENDING').notNull(),
  reason: text('reason'),
  ...timestamps,
}, (table) => [
  index('duplicate_groups_org_idx').on(table.organizationId),
  index('duplicate_groups_canonical_idx').on(table.canonicalEntityId),
]);

export const pipelineJobs = pgTable('pipeline_jobs', {
  id: uuid('id').defaultRandom().primaryKey(),
  searchExecutionId: uuid('search_execution_id').references(() => searchExecutions.id, { onDelete: 'set null' }),
  jobType: varchar('job_type', { length: 100 }).notNull(),
  status: varchar('status', { length: 50 }).default('PENDING').notNull(),
  bullJobId: varchar('bull_job_id', { length: 255 }),
  attempts: integer('attempts').default(0).notNull(),
  errorMessage: text('error_message'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  ...timestamps,
}, (table) => [index('pipeline_jobs_execution_idx').on(table.searchExecutionId), index('pipeline_jobs_type_idx').on(table.jobType), index('pipeline_jobs_status_idx').on(table.status), index('pipeline_jobs_bull_id_idx').on(table.bullJobId)]);

export const exportsTable = pgTable('exports', {
  id: uuid('id').defaultRandom().primaryKey(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'restrict' }),
  requestedByUserId: uuid('requested_by_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  searchExecutionId: uuid('search_execution_id').references(() => searchExecutions.id, { onDelete: 'set null' }),
  format: varchar('format', { length: 20 }).notNull(),
  status: varchar('status', { length: 50 }).default('QUEUED').notNull(),
  filters: jsonb('filters').notNull().default({}),
  fields: jsonb('fields').notNull().default([]),
  fileName: varchar('file_name', { length: 255 }),
  filePath: text('file_path'),
  fileSize: integer('file_size'),
  rowCount: integer('row_count'),
  errorMessage: text('error_message'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  fileUrl: text('file_url'),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  idempotencyKey: varchar('idempotency_key', { length: 512 }),
  ...timestamps,
}, (table) => [index('exports_org_idx').on(table.organizationId), index('exports_requested_by_idx').on(table.requestedByUserId), index('exports_status_idx').on(table.status), index('exports_created_at_idx').on(table.createdAt), index('exports_idempotency_idx').on(table.organizationId, table.idempotencyKey)]);

export const usageEvents = pgTable('usage_events', {
  id: uuid('id').defaultRandom().primaryKey(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'restrict' }),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  eventType: varchar('event_type', { length: 100 }).notNull(),
  operation: varchar('operation', { length: 100 }).notNull().default('UNKNOWN'),
  provider: varchar('provider', { length: 100 }),
  resourceType: varchar('resource_type', { length: 100 }),
  resourceId: uuid('resource_id'),
  quantity: integer('quantity').default(1).notNull(),
  status: varchar('status', { length: 50 }).notNull().default('COMPLETED'),
  estimatedCost: numeric('estimated_cost', { precision: 12, scale: 6 }),
  costStatus: varchar('cost_status', { length: 20 }).notNull().default('UNKNOWN'),
  requestId: varchar('request_id', { length: 255 }),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('usage_events_org_idx').on(table.organizationId),
  index('usage_events_user_idx').on(table.userId),
  index('usage_events_event_type_idx').on(table.eventType),
  index('usage_events_operation_idx').on(table.operation),
  index('usage_events_provider_idx').on(table.provider),
  index('usage_events_status_idx').on(table.status),
  index('usage_events_created_at_idx').on(table.createdAt),
  index('usage_events_org_operation_created_idx').on(table.organizationId, table.operation, table.createdAt),
  check('usage_events_quantity_positive_check', sql`${table.quantity} > 0`),
  check('usage_events_cost_status_check', sql`${table.costStatus} in ('ACTUAL', 'ESTIMATED', 'UNKNOWN')`),
]);

export const organizationLimits = pgTable('organization_limits', {
  id: uuid('id').defaultRandom().primaryKey(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'restrict' }),
  requestsPerMinute: integer('requests_per_minute').notNull(),
  requestsPerHour: integer('requests_per_hour').notNull(),
  requestsPerDay: integer('requests_per_day').notNull(),
  aiRequestsPerMinute: integer('ai_requests_per_minute').notNull(),
  aiRequestsPerDay: integer('ai_requests_per_day').notNull(),
  dailySearchLimit: integer('daily_search_limit').notNull(),
  dailyExportLimit: integer('daily_export_limit').notNull(),
  dailyAiLimit: integer('daily_ai_limit').notNull(),
  maxLeadsPerSearch: integer('max_leads_per_search').notNull(),
  maxExportRows: integer('max_export_rows').notNull(),
  enabled: boolean('enabled').default(true).notNull(),
  ...timestamps,
}, (table) => [
  uniqueIndex('organization_limits_org_unique').on(table.organizationId),
  index('organization_limits_enabled_idx').on(table.enabled),
  check('organization_limits_positive_check', sql`${table.requestsPerMinute} > 0 and ${table.requestsPerHour} > 0 and ${table.requestsPerDay} > 0 and ${table.aiRequestsPerMinute} > 0 and ${table.aiRequestsPerDay} > 0 and ${table.dailySearchLimit} >= 0 and ${table.dailyExportLimit} >= 0 and ${table.dailyAiLimit} >= 0 and ${table.maxLeadsPerSearch} > 0 and ${table.maxExportRows} > 0`),
]);

export const auditLogs = pgTable('audit_logs', {
  id: uuid('id').defaultRandom().primaryKey(),
  organizationId: uuid('organization_id').references(() => organizations.id, { onDelete: 'set null' }),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  action: varchar('action', { length: 100 }).notNull(),
  entityType: varchar('entity_type', { length: 100 }).notNull(),
  entityId: uuid('entity_id'),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [index('audit_logs_org_idx').on(table.organizationId), index('audit_logs_user_idx').on(table.userId), index('audit_logs_entity_idx').on(table.entityType, table.entityId), index('audit_logs_created_at_idx').on(table.createdAt)]);

export const organizationsRelations = relations(organizations, ({ many }) => ({
  members: many(organizationMembers), configurations: many(searchConfigurations), executions: many(searchExecutions), companies: many(companies), sourceRecords: many(sourceRecords), exports: many(exportsTable), usageEvents: many(usageEvents), auditLogs: many(auditLogs),
}));
export const usersRelations = relations(users, ({ many }) => ({ memberships: many(organizationMembers), configurations: many(searchConfigurations), exports: many(exportsTable), usageEvents: many(usageEvents), auditLogs: many(auditLogs) }));
export const organizationMembersRelations = relations(organizationMembers, ({ one }) => ({ organization: one(organizations, { fields: [organizationMembers.organizationId], references: [organizations.id] }), user: one(users, { fields: [organizationMembers.userId], references: [users.id] }) }));
export const searchConfigurationsRelations = relations(searchConfigurations, ({ one, many }) => ({ organization: one(organizations, { fields: [searchConfigurations.organizationId], references: [organizations.id] }), createdBy: one(users, { fields: [searchConfigurations.createdByUserId], references: [users.id] }), executions: many(searchExecutions) }));
export const searchExecutionsRelations = relations(searchExecutions, ({ one, many }) => ({ configuration: one(searchConfigurations, { fields: [searchExecutions.searchConfigurationId], references: [searchConfigurations.id] }), organization: one(organizations, { fields: [searchExecutions.organizationId], references: [organizations.id] }), sourceRecords: many(sourceRecords), pipelineJobs: many(pipelineJobs), exports: many(exportsTable) }));
export const companiesRelations = relations(companies, ({ one, many }) => ({ organization: one(organizations, { fields: [companies.organizationId], references: [organizations.id] }), locations: many(companyLocations), contacts: many(companyContacts), socialProfiles: many(companySocialProfiles), sourceRecords: many(sourceRecords), evidence: many(leadEvidence), classifications: many(leadClassifications), verifications: many(leadVerifications), duplicates: many(leadDuplicates, { relationName: 'companyDuplicates' }), duplicateOf: many(leadDuplicates, { relationName: 'duplicateCompany' }) }));
export const companyLocationsRelations = relations(companyLocations, ({ one }) => ({ company: one(companies, { fields: [companyLocations.companyId], references: [companies.id] }) }));
export const companyContactsRelations = relations(companyContacts, ({ one, many }) => ({ company: one(companies, { fields: [companyContacts.companyId], references: [companies.id] }), evidence: many(leadEvidence), verifications: many(leadVerifications) }));
export const companySocialProfilesRelations = relations(companySocialProfiles, ({ one }) => ({ company: one(companies, { fields: [companySocialProfiles.companyId], references: [companies.id] }) }));
export const sourceRecordsRelations = relations(sourceRecords, ({ one, many }) => ({ organization: one(organizations, { fields: [sourceRecords.organizationId], references: [organizations.id] }), execution: one(searchExecutions, { fields: [sourceRecords.searchExecutionId], references: [searchExecutions.id] }), company: one(companies, { fields: [sourceRecords.companyId], references: [companies.id] }), evidence: many(leadEvidence) }));
export const leadEvidenceRelations = relations(leadEvidence, ({ one }) => ({ company: one(companies, { fields: [leadEvidence.companyId], references: [companies.id] }), contact: one(companyContacts, { fields: [leadEvidence.contactId], references: [companyContacts.id] }), sourceRecord: one(sourceRecords, { fields: [leadEvidence.sourceRecordId], references: [sourceRecords.id] }) }));
export const leadClassificationsRelations = relations(leadClassifications, ({ one }) => ({ company: one(companies, { fields: [leadClassifications.companyId], references: [companies.id] }) }));
export const leadVerificationsRelations = relations(leadVerifications, ({ one }) => ({ company: one(companies, { fields: [leadVerifications.companyId], references: [companies.id] }), contact: one(companyContacts, { fields: [leadVerifications.contactId], references: [companyContacts.id] }) }));
export const leadDuplicatesRelations = relations(leadDuplicates, ({ one }) => ({ company: one(companies, { fields: [leadDuplicates.companyId], references: [companies.id], relationName: 'companyDuplicates' }), duplicateCompany: one(companies, { fields: [leadDuplicates.duplicateCompanyId], references: [companies.id], relationName: 'duplicateCompany' }) }));
export const pipelineJobsRelations = relations(pipelineJobs, ({ one }) => ({ execution: one(searchExecutions, { fields: [pipelineJobs.searchExecutionId], references: [searchExecutions.id] }) }));
export const exportsRelations = relations(exportsTable, ({ one }) => ({ organization: one(organizations, { fields: [exportsTable.organizationId], references: [organizations.id] }), requestedBy: one(users, { fields: [exportsTable.requestedByUserId], references: [users.id] }), execution: one(searchExecutions, { fields: [exportsTable.searchExecutionId], references: [searchExecutions.id] }) }));
export const usageEventsRelations = relations(usageEvents, ({ one }) => ({ organization: one(organizations, { fields: [usageEvents.organizationId], references: [organizations.id] }), user: one(users, { fields: [usageEvents.userId], references: [users.id] }) }));
export const auditLogsRelations = relations(auditLogs, ({ one }) => ({ organization: one(organizations, { fields: [auditLogs.organizationId], references: [organizations.id] }), user: one(users, { fields: [auditLogs.userId], references: [users.id] }) }));