import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq, inArray, isNotNull, ne, or } from 'drizzle-orm';
import { DRIZZLE } from '../database/database.constants';
import type { Database } from '../database/database.types';
import { auditLogs, companies, companyContacts, companySocialProfiles, leadDuplicates, leadEvidence, leadQualifications, leadVerifications, pipelineExecutions, researchExecutions, searchExecutions, sourceRecords, verificationConflicts } from '../database/schema/schema';
import type { PipelineCounters } from './pipeline.types';
import { explicitResultCount } from '../search/search-plan.limits';
import type { SearchPlan } from '../search/types/search-plan.types';

export type PipelineExecutionRow = typeof pipelineExecutions.$inferSelect;

@Injectable()
export class PipelineRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  findActive(organizationId: string, searchId: string) {
    return this.db.select().from(pipelineExecutions).where(and(
      eq(pipelineExecutions.organizationId, organizationId),
      eq(pipelineExecutions.searchId, searchId),
      inArray(pipelineExecutions.status, ['QUEUED', 'RUNNING']),
    )).orderBy(desc(pipelineExecutions.createdAt)).limit(1).then((rows) => rows[0] ?? null);
  }

  findLatest(organizationId: string, searchId: string) {
    return this.db.select().from(pipelineExecutions).where(and(
      eq(pipelineExecutions.organizationId, organizationId),
      eq(pipelineExecutions.searchId, searchId),
    )).orderBy(desc(pipelineExecutions.createdAt)).limit(1).then((rows) => rows[0] ?? null);
  }

  findBySearchExecution(organizationId: string, searchExecutionId: string) {
    return this.db.select().from(pipelineExecutions).where(and(
      eq(pipelineExecutions.organizationId, organizationId),
      eq(pipelineExecutions.searchExecutionId, searchExecutionId),
    )).orderBy(desc(pipelineExecutions.createdAt)).limit(1).then((rows) => rows[0] ?? null);
  }

  findById(organizationId: string, pipelineExecutionId: string) {
    return this.db.select().from(pipelineExecutions).where(and(
      eq(pipelineExecutions.organizationId, organizationId),
      eq(pipelineExecutions.id, pipelineExecutionId),
    )).limit(1).then((rows) => rows[0] ?? null);
  }

  async insert(values: typeof pipelineExecutions.$inferInsert) {
    const [created] = await this.db.insert(pipelineExecutions).values(values).returning();
    return created;
  }

  async update(organizationId: string, pipelineExecutionId: string, values: Partial<typeof pipelineExecutions.$inferInsert>) {
    const [updated] = await this.db.update(pipelineExecutions).set({ ...values, updatedAt: new Date() }).where(and(
      eq(pipelineExecutions.organizationId, organizationId),
      eq(pipelineExecutions.id, pipelineExecutionId),
    )).returning();
    return updated ?? null;
  }

  getSearchExecution(organizationId: string, searchExecutionId: string) {
    return this.db.select().from(searchExecutions).where(and(
      eq(searchExecutions.organizationId, organizationId),
      eq(searchExecutions.id, searchExecutionId),
    )).limit(1).then((rows) => rows[0] ?? null);
  }

  async listCompanyIds(organizationId: string, searchExecutionId: string) {
    const rows = await this.db.select({ companyId: sourceRecords.companyId }).from(sourceRecords).where(and(
      eq(sourceRecords.organizationId, organizationId),
      eq(sourceRecords.searchExecutionId, searchExecutionId),
    )).groupBy(sourceRecords.companyId);
    return rows.flatMap((row) => row.companyId ? [row.companyId] : []);
  }

  async listContactIds(organizationId: string, companyIds: string[]) {
    if (!companyIds.length) return [];
    return this.db.select({ id: companyContacts.id, companyId: companyContacts.companyId }).from(companyContacts)
      .innerJoin(companies, eq(companies.id, companyContacts.companyId))
      .where(and(eq(companies.organizationId, organizationId), inArray(companyContacts.companyId, companyIds)));
  }

  async countEvidence(organizationId: string, companyIds: string[]) {
    return this.countJoined(leadEvidence, organizationId, companyIds);
  }

  async counters(organizationId: string, searchExecutionId: string): Promise<PipelineCounters> {
    const companyIds = await this.listCompanyIds(organizationId, searchExecutionId);
    const [contactsFound, decisionMakersFound, decisionMakerEmailsFound, evidenceCollected, verifiedFields, conflictsFound, duplicatesFound, qualifiedLeads, needsReview, rejected, websitesResearched, socialProfilesFound, facts] = await Promise.all([
      this.countContacts(organizationId, companyIds, false),
      this.countContacts(organizationId, companyIds, true),
      this.countDecisionMakerEmails(organizationId, companyIds),
      this.countEvidence(organizationId, companyIds),
      this.countVerified(organizationId, companyIds),
      this.countConflicts(organizationId, companyIds),
      this.countDuplicates(organizationId, companyIds),
      this.countQualification(organizationId, searchExecutionId, 'QUALIFIED'),
      this.countQualification(organizationId, searchExecutionId, 'NEEDS_REVIEW'),
      this.countQualification(organizationId, searchExecutionId, 'NOT_QUALIFIED'),
      this.countResearched(organizationId, companyIds),
      this.countSocialProfiles(organizationId, companyIds),
      this.companyFacts(organizationId, companyIds),
    ]);
    const websitesFound = facts.filter((row) => Boolean(row.website?.trim())).length;
    const companySizeFound = facts.filter((row) => row.employeeCount != null || Boolean(row.employeeRange?.trim())).length;
    const execution = await this.executionPlan(organizationId, searchExecutionId);
    const requestedCount = explicitResultCount(execution.plan);
    const discovered = execution.totalCandidates > 0 ? execution.totalCandidates : companyIds.length;
    return {
      companiesDiscovered: discovered,
      companiesPersisted: companyIds.length,
      companiesProcessed: companyIds.length,
      requestedCount: requestedCount ?? null,
      discoveryShortfall: requestedCount === undefined ? null : Math.max(0, requestedCount - companyIds.length),
      companySizeRequested: Boolean(execution.plan?.companySize),
      websitesFound,
      websitesNotFound: facts.length - websitesFound,
      websitesResearched,
      companySizeFound,
      companySizeUnknown: facts.length - companySizeFound,
      decisionMakersFound,
      decisionMakerEmailsFound,
      companyEmailsFound: facts.filter((row) => Boolean(row.email?.trim())).length,
      socialProfilesFound,
      contactsFound,
      evidenceCollected,
      verifiedFields,
      conflictsFound,
      duplicatesFound,
      qualifiedLeads,
      needsReview,
      rejected,
    };
  }

  private async countContacts(organizationId: string, companyIds: string[], namedOnly: boolean) {
    if (!companyIds.length) return 0;
    const filters = [eq(companies.organizationId, organizationId), inArray(companyContacts.companyId, companyIds)];
    if (namedOnly) filters.push(isNotNull(companyContacts.fullName));
    const [row] = await this.db.select({ total: count() }).from(companyContacts).innerJoin(companies, eq(companies.id, companyContacts.companyId)).where(and(...filters));
    return Number(row?.total ?? 0);
  }

  private async countJoined(table: typeof leadEvidence, organizationId: string, companyIds: string[]) {
    if (!companyIds.length) return 0;
    const [row] = await this.db.select({ total: count() }).from(table).innerJoin(companies, eq(companies.id, table.companyId)).where(and(eq(companies.organizationId, organizationId), inArray(table.companyId, companyIds)));
    return Number(row?.total ?? 0);
  }

  private countVerified(organizationId: string, companyIds: string[]) {
    if (!companyIds.length) return Promise.resolve(0);
    return this.db.select({ total: count() }).from(leadVerifications).where(and(
      eq(leadVerifications.organizationId, organizationId),
      inArray(leadVerifications.companyId, companyIds),
      inArray(leadVerifications.status, ['VERIFIED', 'SUPPORTED']),
    )).then((rows) => Number(rows[0]?.total ?? 0));
  }

  private countConflicts(organizationId: string, companyIds: string[]) {
    if (!companyIds.length) return Promise.resolve(0);
    return this.db.select({ total: count() }).from(verificationConflicts).where(and(
      eq(verificationConflicts.organizationId, organizationId),
      inArray(verificationConflicts.companyId, companyIds),
    )).then((rows) => Number(rows[0]?.total ?? 0));
  }

  private countDuplicates(organizationId: string, companyIds: string[]) {
    if (!companyIds.length) return Promise.resolve(0);
    return this.db.select({ total: count() }).from(leadDuplicates).innerJoin(companies, eq(companies.id, leadDuplicates.companyId)).where(and(
      eq(companies.organizationId, organizationId),
      inArray(leadDuplicates.companyId, companyIds),
    )).then((rows) => Number(rows[0]?.total ?? 0));
  }

  private countQualification(organizationId: string, searchExecutionId: string, status: string) {
    return this.db.select({ total: count() }).from(leadQualifications).where(and(
      eq(leadQualifications.organizationId, organizationId),
      eq(leadQualifications.searchExecutionId, searchExecutionId),
      eq(leadQualifications.status, status),
    )).then((rows) => Number(rows[0]?.total ?? 0));
  }

  private async companyFacts(organizationId: string, companyIds: string[]) {
    if (!companyIds.length) return [];
    return this.db.select({
      website: companies.website,
      email: companies.email,
      employeeCount: companies.employeeCount,
      employeeRange: companies.employeeRange,
    }).from(companies).where(and(eq(companies.organizationId, organizationId), inArray(companies.id, companyIds)));
  }

  private async countDecisionMakerEmails(organizationId: string, companyIds: string[]) {
    if (!companyIds.length) return 0;
    const [row] = await this.db.select({ total: count() }).from(companyContacts).innerJoin(companies, eq(companies.id, companyContacts.companyId)).where(and(
      eq(companies.organizationId, organizationId),
      inArray(companyContacts.companyId, companyIds),
      isNotNull(companyContacts.email),
      ne(companyContacts.emailStatus, 'NOT_FOUND'),
    ));
    return Number(row?.total ?? 0);
  }

  private async countSocialProfiles(organizationId: string, companyIds: string[]) {
    if (!companyIds.length) return 0;
    const [companyProfiles, people] = await Promise.all([
      this.db.select({ total: count() }).from(companySocialProfiles).innerJoin(companies, eq(companies.id, companySocialProfiles.companyId)).where(and(eq(companies.organizationId, organizationId), inArray(companySocialProfiles.companyId, companyIds))),
      this.db.select({ total: count() }).from(companyContacts).innerJoin(companies, eq(companies.id, companyContacts.companyId)).where(and(
        eq(companies.organizationId, organizationId),
        inArray(companyContacts.companyId, companyIds),
        or(isNotNull(companyContacts.linkedinUrl), isNotNull(companyContacts.facebookUrl), isNotNull(companyContacts.instagramUrl), isNotNull(companyContacts.youtubeUrl)),
      )),
    ]);
    return Number(companyProfiles[0]?.total ?? 0) + Number(people[0]?.total ?? 0);
  }

  private countResearched(organizationId: string, companyIds: string[]) {
    if (!companyIds.length) return Promise.resolve(0);
    return this.db.select({ total: count() }).from(researchExecutions).where(and(
      eq(researchExecutions.organizationId, organizationId),
      inArray(researchExecutions.companyId, companyIds),
      inArray(researchExecutions.status, ['COMPLETED', 'PARTIAL']),
    )).then((rows) => Number(rows[0]?.total ?? 0));
  }

  private async executionPlan(organizationId: string, searchExecutionId: string): Promise<{ plan: SearchPlan | null; totalCandidates: number }> {
    const [row] = await this.db.select({
      plan: searchExecutions.structuredPlan,
      totalCandidates: searchExecutions.totalCandidates,
    }).from(searchExecutions).where(and(
      eq(searchExecutions.organizationId, organizationId),
      eq(searchExecutions.id, searchExecutionId),
    )).limit(1);
    const plan = row?.plan && typeof row.plan === 'object' ? row.plan as SearchPlan : null;
    return { plan, totalCandidates: row?.totalCandidates ?? 0 };
  }

  async audit(organizationId: string, userId: string | null, action: string, pipelineExecutionId: string, metadata: Record<string, string | null>) {
    await this.db.insert(auditLogs).values({
      organizationId,
      userId,
      action,
      entityType: 'pipeline_execution',
      entityId: pipelineExecutionId,
      metadata,
    });
  }
}
