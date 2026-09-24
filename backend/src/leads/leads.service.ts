import { Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, count, desc, eq, gte, ilike, inArray, lte, or, sql } from 'drizzle-orm';
import type { Database } from '../database/database.types';
import { Inject } from '@nestjs/common';
import { DRIZZLE } from '../database/database.constants';
import { companies, companyContacts, companyLocations, companySocialProfiles, leadClassifications, leadDuplicates, leadEvidence, leadQualifications, leadScores, leadVerifications, searchConfigurations, searchExecutions, sourceRecords } from '../database/schema/schema';
import { normalizeDomain } from '../deduplication/normalization/normalization';
import type { AuthenticatedUser } from '../auth/auth.types';
import type { ListExecutionsDto } from './dto/list-executions.dto';
import { ListLeadsDto } from './dto/list-leads.dto';

type CompanyRow = typeof companies.$inferSelect;

@Injectable()
export class LeadsService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async list(user: AuthenticatedUser, filters: ListLeadsDto, executionId?: string) {
    const organizationId = user.organizationId;
    const conditions = [eq(companies.organizationId, organizationId)];
    if (executionId || filters.searchExecutionId) {
      const id = executionId ?? filters.searchExecutionId!;
      const rows = await this.db.select({ companyId: sourceRecords.companyId }).from(sourceRecords).where(and(eq(sourceRecords.organizationId, organizationId), eq(sourceRecords.searchExecutionId, id)));
      conditions.push(inArray(companies.id, this.uniqueIds(rows.map((row) => row.companyId).filter((id): id is string => Boolean(id)))));
    }
    if (filters.companyName) conditions.push(ilike(companies.name, `%${filters.companyName}%`));
    if (filters.website) conditions.push(ilike(companies.website, `%${filters.website}%`));
    if (filters.domain) conditions.push(ilike(companies.website, `%${filters.domain}%`));
    if (filters.investorType) conditions.push(eq(companies.investorType, filters.investorType));
    if (filters.investmentStrategy) conditions.push(ilike(companies.investmentStrategy, `%${filters.investmentStrategy}%`));
    if (filters.companySize) conditions.push(or(eq(companies.employeeRange, filters.companySize), eq(companies.employeeCount, Number(filters.companySize) || -1))!);
    if (filters.search) {
      const query = `%${filters.search}%`;
      conditions.push(or(ilike(companies.name, query), ilike(companies.website, query), ilike(companies.description, query))!);
    }
    if (filters.createdFrom) conditions.push(gte(companies.createdAt, new Date(filters.createdFrom)));
    if (filters.createdTo) conditions.push(lte(companies.createdAt, new Date(filters.createdTo)));
    if (filters.hasEmail === true) conditions.push(sql`${companies.email} is not null and length(trim(${companies.email})) > 0`);
    if (filters.hasEmail === false) conditions.push(sql`(${companies.email} is null or length(trim(${companies.email})) = 0)`);
    if (filters.hasPhone === true) conditions.push(sql`${companies.phone} is not null and length(trim(${companies.phone})) > 0`);
    if (filters.hasPhone === false) conditions.push(sql`(${companies.phone} is null or length(trim(${companies.phone})) = 0)`);

    const relatedIds = await this.resolveRelatedCompanyIds(organizationId, filters);
    if (relatedIds) conditions.push(inArray(companies.id, relatedIds));
    const where = and(...conditions);
    const [{ total }] = await this.db.select({ total: count() }).from(companies).where(where);
    const sortColumn = filters.sortBy === 'score'
      ? sql<number>`coalesce((select ${leadScores.score} from ${leadScores} where ${leadScores.companyId} = ${companies.id} and ${leadScores.organizationId} = ${organizationId} and ${leadScores.contactId} is null order by ${leadScores.calculatedAt} desc limit 1), -1)`
      : filters.sortBy === 'companyName' ? companies.name : filters.sortBy === 'updatedAt' ? companies.updatedAt : filters.sortBy === 'lastVerifiedAt' ? companies.lastVerifiedAt : companies.createdAt;
    const rows = await this.db.select().from(companies).where(where).orderBy(filters.sortOrder === 'asc' ? asc(sortColumn) : desc(sortColumn)).limit(filters.limit).offset((filters.page - 1) * filters.limit);
    const data = await this.hydrate(rows, organizationId);
    return { data, pagination: { page: filters.page, limit: filters.limit, total: Number(total), totalPages: Math.ceil(Number(total) / filters.limit) } };
  }

  async detail(user: AuthenticatedUser, id: string) {
    const [company] = await this.db.select().from(companies).where(and(eq(companies.id, id), eq(companies.organizationId, user.organizationId))).limit(1);
    if (!company) throw new NotFoundException('Lead not found');
    const [lead] = await this.hydrate([company], user.organizationId);
    const evidence = await this.db.select({ id: leadEvidence.id, sourceUrl: leadEvidence.sourceUrl, sourceType: leadEvidence.evidenceType, evidenceType: leadEvidence.evidenceType, excerpt: leadEvidence.evidenceText, timestamp: leadEvidence.evidenceTimestamp, metadata: leadEvidence.metadata }).from(leadEvidence).where(eq(leadEvidence.companyId, id));
    const sources = await this.db.select().from(sourceRecords).where(and(eq(sourceRecords.companyId, id), eq(sourceRecords.organizationId, user.organizationId)));
    const executionIds = [...new Set(sources.map((source) => source.searchExecutionId))];
    const executions = executionIds.length ? await this.db.select().from(searchExecutions).where(and(eq(searchExecutions.organizationId, user.organizationId), inArray(searchExecutions.id, executionIds))) : [];
    return { ...lead, evidence, sourceRecords: sources, searchExecutions: executions };
  }

  async review(user: AuthenticatedUser, id: string) {
    const detail = await this.detail(user, id);
    const breakdown = detail.score?.breakdown;
    const dataCompleteness = typeof breakdown === 'object' && breakdown !== null && 'completenessPercentage' in breakdown && typeof breakdown.completenessPercentage === 'number' ? breakdown.completenessPercentage : 0;
    return { classification: detail.classification, score: detail.score, verification: detail.verification, qualification: detail.qualification, evidence: detail.evidence, duplicates: detail.duplicate, decisionMaker: detail.contact, dataCompleteness };
  }

  async listExecutions(user: AuthenticatedUser, filters: ListExecutionsDto) {
    const conditions = [eq(searchExecutions.organizationId, user.organizationId)];
    if (filters.status) conditions.push(eq(searchExecutions.status, filters.status));
    if (filters.createdFrom) conditions.push(gte(searchExecutions.createdAt, new Date(filters.createdFrom)));
    if (filters.createdTo) conditions.push(lte(searchExecutions.createdAt, new Date(filters.createdTo)));
    const where = and(...conditions);
    const [{ total }] = await this.db.select({ total: count() }).from(searchExecutions).where(where);
    const executions = await this.db.select({ execution: searchExecutions, prompt: searchConfigurations.originalPrompt }).from(searchExecutions).innerJoin(searchConfigurations, eq(searchConfigurations.id, searchExecutions.searchConfigurationId)).where(where).orderBy(desc(searchExecutions.createdAt)).limit(filters.limit).offset((filters.page - 1) * filters.limit);
    const ids = executions.map((item) => item.execution.id);
    const counts = ids.length ? await this.db.select({ executionId: sourceRecords.searchExecutionId, count: count() }).from(sourceRecords).where(and(eq(sourceRecords.organizationId, user.organizationId), inArray(sourceRecords.searchExecutionId, ids))).groupBy(sourceRecords.searchExecutionId) : [];
    const companyCounts = ids.length ? await this.db.select({ executionId: sourceRecords.searchExecutionId, count: sql<number>`count(distinct ${sourceRecords.companyId})` }).from(sourceRecords).where(and(eq(sourceRecords.organizationId, user.organizationId), inArray(sourceRecords.searchExecutionId, ids))).groupBy(sourceRecords.searchExecutionId) : [];
    const qualifiedCounts = ids.length ? await this.db.select({ executionId: leadQualifications.searchExecutionId, count: count() }).from(leadQualifications).where(and(eq(leadQualifications.organizationId, user.organizationId), inArray(leadQualifications.searchExecutionId, ids), eq(leadQualifications.status, 'QUALIFIED'))).groupBy(leadQualifications.searchExecutionId) : [];
    const countMap = new Map(counts.map((item) => [item.executionId, Number(item.count)]));
    const companyMap = new Map(companyCounts.map((item) => [item.executionId, Number(item.count)]));
    const qualifiedMap = new Map(qualifiedCounts.map((item) => [item.executionId, Number(item.count)]));
    return { data: executions.map((item) => ({ id: item.execution.id, searchId: item.execution.searchConfigurationId, userPrompt: item.prompt, status: item.execution.status, createdAt: item.execution.createdAt, completedAt: item.execution.completedAt, resultCount: countMap.get(item.execution.id) ?? 0, companyCount: companyMap.get(item.execution.id) ?? 0, qualifiedLeadCount: qualifiedMap.get(item.execution.id) ?? 0 })), pagination: { page: filters.page, limit: filters.limit, total: Number(total), totalPages: Math.ceil(Number(total) / filters.limit) } };
  }

  private async resolveRelatedCompanyIds(organizationId: string, filters: ListLeadsDto): Promise<string[] | null> {
    const sets: string[][] = [];
    if (filters.classification || filters.classificationConfidence !== undefined) {
      const rows = await this.db.select({ companyId: leadClassifications.companyId }).from(leadClassifications).where(and(eq(leadClassifications.organizationId, organizationId), filters.classification ? eq(leadClassifications.decision, filters.classification) : undefined, filters.classificationConfidence !== undefined ? gte(leadClassifications.confidence, filters.classificationConfidence.toFixed(4)) : undefined));
      sets.push(this.uniqueIds(rows.map((row) => row.companyId)));
    }
    if (filters.minScore !== undefined || filters.maxScore !== undefined || filters.scoreBand) {
      const rows = await this.db.select({ companyId: leadScores.companyId }).from(leadScores).where(and(eq(leadScores.organizationId, organizationId), filters.minScore !== undefined ? gte(leadScores.score, filters.minScore) : undefined, filters.maxScore !== undefined ? lte(leadScores.score, filters.maxScore) : undefined, filters.scoreBand ? eq(leadScores.band, filters.scoreBand) : undefined));
      sets.push(this.uniqueIds(rows.map((row) => row.companyId)));
    }
    if (filters.verificationStatus || filters.lastVerifiedFrom || filters.lastVerifiedTo) {
      const rows = await this.db.select({ companyId: leadVerifications.companyId }).from(leadVerifications).where(and(eq(leadVerifications.organizationId, organizationId), filters.verificationStatus ? eq(leadVerifications.status, filters.verificationStatus) : undefined, filters.lastVerifiedFrom ? gte(leadVerifications.checkedAt, new Date(filters.lastVerifiedFrom)) : undefined, filters.lastVerifiedTo ? lte(leadVerifications.checkedAt, new Date(filters.lastVerifiedTo)) : undefined));
      sets.push(this.uniqueIds(rows.map((row) => row.companyId)));
    }
    if (filters.hasDecisionMaker !== undefined || filters.contactTitle || filters.hasLinkedIn !== undefined || filters.hasFacebook !== undefined || filters.hasInstagram !== undefined) {
      const rows = await this.db.select({ contact: companyContacts }).from(companyContacts).innerJoin(companies, eq(companies.id, companyContacts.companyId)).where(and(eq(companies.organizationId, organizationId), filters.contactTitle ? ilike(companyContacts.title, `%${filters.contactTitle}%`) : undefined, filters.hasDecisionMaker === true ? sql`${companyContacts.fullName} is not null` : filters.hasDecisionMaker === false ? sql`${companyContacts.fullName} is null` : undefined, filters.hasLinkedIn === true ? sql`${companyContacts.linkedinUrl} is not null` : filters.hasLinkedIn === false ? sql`${companyContacts.linkedinUrl} is null` : undefined, filters.hasFacebook === true ? sql`${companyContacts.facebookUrl} is not null` : filters.hasFacebook === false ? sql`${companyContacts.facebookUrl} is null` : undefined, filters.hasInstagram === true ? sql`${companyContacts.instagramUrl} is not null` : filters.hasInstagram === false ? sql`${companyContacts.instagramUrl} is null` : undefined));
      sets.push(this.uniqueIds(rows.map((row) => row.contact.companyId)));
    }
    if (filters.propertyType || filters.marketServed) {
      const rows = await this.db.select({ id: companies.id }).from(companies).where(and(eq(companies.organizationId, organizationId), filters.propertyType ? sql`${companies.propertyTypes}::text ilike ${`%${filters.propertyType}%`}` : undefined, filters.marketServed ? sql`${companies.marketsServed}::text ilike ${`%${filters.marketServed}%`}` : undefined));
      sets.push(this.uniqueIds(rows.map((row) => row.id)));
    }
    if (filters.duplicateStatus) {
      const rows = await this.db.select({ companyId: leadDuplicates.entityAId }).from(leadDuplicates).where(and(eq(leadDuplicates.organizationId, organizationId), eq(leadDuplicates.entityType, 'COMPANY'), eq(leadDuplicates.status, filters.duplicateStatus)));
      sets.push(this.uniqueIds(rows.map((row) => row.companyId)));
    }
    if (filters.qualificationStatus) {
      const rows = await this.db.select({ companyId: leadQualifications.companyId }).from(leadQualifications).where(and(eq(leadQualifications.organizationId, organizationId), eq(leadQualifications.status, filters.qualificationStatus), filters.searchExecutionId ? eq(leadQualifications.searchExecutionId, filters.searchExecutionId) : undefined));
      sets.push(this.uniqueIds(rows.map((row) => row.companyId)));
    }
    if (!sets.length) return null;
    return sets[0].filter((id) => sets.every((set) => set.includes(id)));
  }

  private async hydrate(rows: CompanyRow[], organizationId: string) {
    const ids = rows.map((row) => row.id);
    if (!ids.length) return [];
    const [locations, contacts, socials, classifications, scores, verifications, duplicates, evidenceRows, sourceRows, qualifications] = await Promise.all([
      this.db.select().from(companyLocations).where(inArray(companyLocations.companyId, ids)),
      this.db.select().from(companyContacts).where(inArray(companyContacts.companyId, ids)),
      this.db.select().from(companySocialProfiles).where(inArray(companySocialProfiles.companyId, ids)),
      this.db.select().from(leadClassifications).where(and(eq(leadClassifications.organizationId, organizationId), inArray(leadClassifications.companyId, ids))).orderBy(desc(leadClassifications.createdAt)),
      this.db.select().from(leadScores).where(and(eq(leadScores.organizationId, organizationId), inArray(leadScores.companyId, ids))).orderBy(desc(leadScores.calculatedAt)),
      this.db.select().from(leadVerifications).where(and(eq(leadVerifications.organizationId, organizationId), inArray(leadVerifications.companyId, ids))),
      this.db.select().from(leadDuplicates).where(and(eq(leadDuplicates.organizationId, organizationId), eq(leadDuplicates.entityType, 'COMPANY'), or(inArray(leadDuplicates.entityAId, ids), inArray(leadDuplicates.entityBId, ids)))),
      this.db.select().from(leadEvidence).where(inArray(leadEvidence.companyId, ids)),
      this.db.select().from(sourceRecords).where(and(eq(sourceRecords.organizationId, organizationId), inArray(sourceRecords.companyId, ids))),
      this.db.select().from(leadQualifications).where(and(eq(leadQualifications.organizationId, organizationId), inArray(leadQualifications.companyId, ids))).orderBy(desc(leadQualifications.evaluatedAt)),
    ]);
    return rows.map((company) => {
      const location = locations.find((item) => item.companyId === company.id && item.isPrimary) ?? locations.find((item) => item.companyId === company.id) ?? null;
      const contact = contacts.find((item) => item.companyId === company.id) ?? null;
      const classification = classifications.find((item) => item.companyId === company.id) ?? null;
      const score = scores.find((item) => item.companyId === company.id && item.contactId === null) ?? null;
      const verification = verifications.find((item) => item.companyId === company.id && item.contactId === null) ?? null;
      const duplicate = duplicates.find((item) => item.entityAId === company.id || item.entityBId === company.id) ?? null;
      const qualification = qualifications.find((item) => item.companyId === company.id) ?? null;
      return { id: company.id, company: { id: company.id, name: company.name, website: company.website, domain: normalizeDomain(company.website), phone: company.phone, email: company.email, description: company.description, investorType: company.investorType, investmentStrategy: company.investmentStrategy, propertyTypes: company.propertyTypes, marketsServed: company.marketsServed, companySize: company.employeeCount ?? company.employeeRange, location: location ? { city: location.city, state: location.state, zipCode: location.postalCode, country: location.country, address: location.addressLine1 } : null }, contact: contact ? { id: contact.id, name: contact.fullName, title: contact.title, email: contact.email, phone: contact.phone, linkedin: contact.linkedinUrl, facebook: contact.facebookUrl, instagram: contact.instagramUrl } : null, socialProfiles: socials.filter((item) => item.companyId === company.id), classification: classification ? { decision: classification.decision, confidence: classification.confidence ? Number(classification.confidence) : null } : null, score: score ? { value: score.score, band: score.band, breakdown: score.breakdown } : null, verification: verification ? { status: verification.status, field: verification.field } : null, qualification: qualification ? { status: qualification.status, score: qualification.score, scoreBand: qualification.scoreBand, qualifiedReasons: qualification.qualifiedReasons, disqualifiedReasons: qualification.disqualifiedReasons, needsReviewReasons: qualification.needsReviewReasons, missingOptional: qualification.missingOptional, criterionResults: qualification.criterionResults, evaluatedAt: qualification.evaluatedAt } : null, duplicate: duplicate ? { status: duplicate.status, matchType: duplicate.matchType, confidence: duplicate.confidence ? Number(duplicate.confidence) : null } : { status: 'NO_DUPLICATE' }, evidence: evidenceRows.filter((item) => item.companyId === company.id), sourceUrls: sourceRows.filter((item) => item.companyId === company.id).map((item) => item.sourceUrl), createdAt: company.createdAt, updatedAt: company.updatedAt, lastVerifiedAt: company.lastVerifiedAt };
    });
  }

  async forEachExportBatch(user: AuthenticatedUser, filters: ListLeadsDto, onBatch: (rows: Awaited<ReturnType<LeadsService['list']>>['data']) => Promise<void>) {
    const batchSize = 100;
    let page = 1;
    while (true) {
      const result = await this.list(user, Object.assign(new ListLeadsDto(), filters, { page, limit: batchSize }));
      if (!result.data.length) break;
      await onBatch(result.data);
      if (result.data.length < batchSize) break;
      page += 1;
    }
  }

  private uniqueIds(ids: string[]) { return [...new Set(ids)]; }
}
