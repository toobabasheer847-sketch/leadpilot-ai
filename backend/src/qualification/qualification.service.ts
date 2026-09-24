import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, like } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { DRIZZLE } from '../database/database.constants';
import type { Database } from '../database/database.types';
import {
  auditLogs,
  companies,
  companyContacts,
  companyLocations,
  leadClassifications,
  leadEvidence,
  leadQualifications,
  leadScores,
  leadVerifications,
  qualificationEvidence,
  qualificationReasons,
  searchExecutions,
  sourceRecords,
  verificationConflicts,
} from '../database/schema/schema';
import type { SearchPlan } from '../search/types/search-plan.types';
import type { ScoreBreakdown } from '../scoring/types/scoring.types';
import { calculateDeterministicScore } from '../scoring/scoring.service';
import { UsageService } from '../usage/usage.service';
import { evaluateQualification, normalizeCriteria, QUALIFICATION_VERSION } from './engine/qualification-engine';
import { QualificationQueue } from './qualification.queue';
import type { QualificationJobData } from './types/qualification.types';

@Injectable()
export class QualificationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly queue: QualificationQueue,
    private readonly usage: UsageService,
  ) {}

  async enqueueExecution(searchExecutionId: string, organizationId: string, force = false) {
    const execution = await this.findExecution(searchExecutionId, organizationId);
    await this.usage.checkRequestRate(organizationId, undefined, 'QUALIFICATION');
    const companyIds = await this.companyIdsForExecution(searchExecutionId, organizationId);
    const version = force ? Date.now().toString() : this.criteriaHash(execution.structuredPlan);
    const idempotencyKey = createHash('sha256').update(JSON.stringify({ organizationId, searchExecutionId, version, count: companyIds.length })).digest('hex');
    if (!force) {
      const [existing] = await this.db.select({ id: leadQualifications.id }).from(leadQualifications)
        .where(and(eq(leadQualifications.organizationId, organizationId), eq(leadQualifications.searchExecutionId, searchExecutionId), like(leadQualifications.idempotencyKey, `${idempotencyKey}:%`))).limit(1);
      if (existing) return { status: 'EXISTS' as const, qualificationId: existing.id };
    }
    const job = await this.queue.enqueue({ searchExecutionId, organizationId, force, idempotencyKey });
    await this.audit(organizationId, searchExecutionId, 'LEAD_QUALIFICATION_STARTED', { jobId: job.id, candidates: companyIds.length });
    return { status: 'QUEUED' as const, jobId: job.id };
  }

  qualifyQueued(data: QualificationJobData) {
    return this.runExecution(data);
  }

  async listForExecution(searchExecutionId: string, organizationId: string) {
    await this.findExecution(searchExecutionId, organizationId);
    return this.db.select().from(leadQualifications)
      .where(and(eq(leadQualifications.searchExecutionId, searchExecutionId), eq(leadQualifications.organizationId, organizationId)))
      .orderBy(desc(leadQualifications.evaluatedAt));
  }

  async getByCompany(companyId: string, organizationId: string, searchExecutionId?: string) {
    const conditions = [eq(leadQualifications.companyId, companyId), eq(leadQualifications.organizationId, organizationId)];
    if (searchExecutionId) conditions.push(eq(leadQualifications.searchExecutionId, searchExecutionId));
    const [row] = await this.db.select().from(leadQualifications).where(and(...conditions)).orderBy(desc(leadQualifications.evaluatedAt)).limit(1);
    return row ?? null;
  }

  private async runExecution(data: QualificationJobData) {
    const execution = await this.findExecution(data.searchExecutionId, data.organizationId);
    const criteria = normalizeCriteria(this.asPlan(execution.structuredPlan));
    const companyIds = await this.companyIdsForExecution(data.searchExecutionId, data.organizationId);
    const stored = [];
    for (const companyId of companyIds) {
      const context = await this.loadContext(companyId, data.organizationId, data.searchExecutionId);
      const decision = evaluateQualification(context, criteria);
      const row = await this.persist(data, companyId, context.contacts[0]?.id ?? null, decision);
      if (row) stored.push(row);
    }
    await this.usage.recordUsage({
      organizationId: data.organizationId,
      operation: 'QUALIFICATION',
      provider: 'qualification-engine',
      resourceType: 'search_execution',
      resourceId: data.searchExecutionId,
      units: Math.max(1, stored.length || 1),
      status: 'COMPLETED',
      metadata: {
        qualified: stored.filter((row) => row.status === 'QUALIFIED').length,
        notQualified: stored.filter((row) => row.status === 'NOT_QUALIFIED').length,
        needsReview: stored.filter((row) => row.status === 'NEEDS_REVIEW').length,
      },
    });
    await this.audit(data.organizationId, data.searchExecutionId, 'LEAD_QUALIFICATION_COMPLETED', { count: stored.length });
    return stored;
  }

  private async persist(data: QualificationJobData, companyId: string, contactId: string | null, decision: ReturnType<typeof evaluateQualification>) {
    const idempotencyKey = `${data.idempotencyKey}:${companyId}`;
    const [row] = await this.db.insert(leadQualifications).values({
      organizationId: data.organizationId,
      companyId,
      contactId,
      searchExecutionId: data.searchExecutionId,
      status: decision.status,
      score: decision.score,
      scoreBand: decision.scoreBand,
      scoreBreakdown: decision.scoreBreakdown,
      criteriaSnapshot: decision.criteria,
      criterionResults: decision.criterionResults,
      qualifiedReasons: decision.qualifiedReasons,
      disqualifiedReasons: decision.disqualifiedReasons,
      needsReviewReasons: decision.needsReviewReasons,
      missingOptional: decision.missingOptional,
      version: QUALIFICATION_VERSION,
      idempotencyKey,
      evaluatedAt: new Date(),
    }).onConflictDoNothing({ target: [leadQualifications.organizationId, leadQualifications.idempotencyKey] }).returning();
    if (!row) return null;

    for (const message of decision.qualifiedReasons) {
      await this.db.insert(qualificationReasons).values({ qualificationId: row.id, organizationId: data.organizationId, reasonType: 'QUALIFIED', criterion: 'summary', message });
    }
    for (const message of decision.disqualifiedReasons) {
      await this.db.insert(qualificationReasons).values({ qualificationId: row.id, organizationId: data.organizationId, reasonType: 'NOT_QUALIFIED', criterion: 'summary', message });
    }
    for (const message of decision.needsReviewReasons) {
      await this.db.insert(qualificationReasons).values({ qualificationId: row.id, organizationId: data.organizationId, reasonType: 'NEEDS_REVIEW', criterion: 'summary', message });
    }
    for (const item of decision.criterionResults) {
      await this.db.insert(qualificationEvidence).values({
        qualificationId: row.id,
        organizationId: data.organizationId,
        criterion: item.criterion,
        result: item.result,
        source: item.source,
        sourceUrl: item.sourceUrl,
        evidenceExcerpt: item.evidenceExcerpt,
        retrievedAt: item.retrievedAt ? new Date(item.retrievedAt) : null,
        verificationStatus: item.verificationStatus,
        evidenceId: item.evidenceId ?? null,
      });
    }
    return row;
  }

  private async loadContext(companyId: string, organizationId: string, searchExecutionId: string) {
    const [company] = await this.db.select().from(companies).where(and(eq(companies.id, companyId), eq(companies.organizationId, organizationId))).limit(1);
    if (!company) throw new NotFoundException('Company not found');
    const [location] = await this.db.select().from(companyLocations).where(eq(companyLocations.companyId, companyId)).limit(1);
    const contacts = await this.db.select().from(companyContacts).where(eq(companyContacts.companyId, companyId));
    const evidence = await this.db.select().from(leadEvidence).where(eq(leadEvidence.companyId, companyId));
    const verifications = await this.db.select().from(leadVerifications).where(and(eq(leadVerifications.companyId, companyId), eq(leadVerifications.organizationId, organizationId)));
    const conflicts = await this.db.select().from(verificationConflicts).where(and(eq(verificationConflicts.companyId, companyId), eq(verificationConflicts.organizationId, organizationId)));
    const [classification] = await this.db.select().from(leadClassifications).where(and(eq(leadClassifications.companyId, companyId), eq(leadClassifications.organizationId, organizationId))).orderBy(desc(leadClassifications.createdAt)).limit(1);
    const [scoreRow] = await this.db.select().from(leadScores).where(and(eq(leadScores.companyId, companyId), eq(leadScores.organizationId, organizationId))).orderBy(desc(leadScores.calculatedAt)).limit(1);

    let score = scoreRow ? { value: scoreRow.score, band: scoreRow.band, breakdown: scoreRow.breakdown as ScoreBreakdown } : null;
    if (!score) {
      const contact = contacts[0] ?? null;
      const breakdown = calculateDeterministicScore(
        company,
        contact,
        classification ? { decision: classification.decision } : null,
        verifications.map((item) => ({ field: item.field, status: item.status, evidenceId: item.evidenceId })),
        evidence.map((item) => ({ id: item.id, evidenceType: item.evidenceType, evidenceText: item.evidenceText, retrievedAt: item.evidenceTimestamp })),
      );
      score = { value: breakdown.total, band: breakdown.band, breakdown };
      await this.db.insert(leadScores).values({
        companyId,
        contactId: contact?.id ?? null,
        organizationId,
        searchExecutionId,
        score: breakdown.total,
        band: breakdown.band,
        version: breakdown.version,
        breakdown,
        idempotencyKey: createHash('sha256').update(JSON.stringify({ organizationId, companyId, searchExecutionId, version: breakdown.version, source: 'qualification' })).digest('hex'),
        calculatedAt: new Date(),
      }).onConflictDoNothing({ target: [leadScores.organizationId, leadScores.idempotencyKey] });
    }

    return {
      company: {
        id: company.id,
        name: company.name,
        website: company.website,
        email: company.email,
        phone: company.phone,
        description: company.description,
        category: company.category,
        investorType: company.investorType,
        employeeCount: company.employeeCount,
        employeeRange: company.employeeRange,
        verificationStatus: company.verificationStatus,
      },
      location: location ? { city: location.city, state: location.state, country: location.country, postalCode: location.postalCode } : null,
      contacts: contacts.map((contact) => ({
        id: contact.id,
        fullName: contact.fullName,
        title: contact.title,
        normalizedRole: contact.normalizedRole,
        companyRelationship: contact.companyRelationship,
        email: contact.email,
        phone: contact.phone,
        linkedinUrl: contact.linkedinUrl,
        facebookUrl: contact.facebookUrl,
        instagramUrl: contact.instagramUrl,
        youtubeUrl: contact.youtubeUrl,
        verificationStatus: contact.verificationStatus,
      })),
      evidence: evidence.map((item) => ({
        id: item.id,
        evidenceType: item.evidenceType,
        sourceUrl: item.sourceUrl,
        evidenceText: item.evidenceText,
        provider: item.provider,
        sourceType: item.sourceType,
        retrievedAt: item.evidenceTimestamp,
        metadata: item.metadata,
      })),
      verifications: verifications.map((item) => ({ field: item.field, status: item.status, fieldValue: item.fieldValue, evidenceId: item.evidenceId })),
      conflicts: conflicts.map((item) => ({ fieldName: item.fieldName, requiresReview: item.requiresReview, resolutionStatus: item.resolutionStatus })),
      classification: classification ? {
        decision: classification.decision,
        confidence: classification.confidence ? Number(classification.confidence) : null,
        category: classification.category,
        investorType: classification.investorType,
        positiveEvidence: classification.positiveEvidence,
        negativeEvidence: classification.negativeEvidence,
        missingEvidence: classification.missingEvidence,
        exclusionReason: classification.exclusionReason,
      } : null,
      score,
    };
  }

  private async companyIdsForExecution(searchExecutionId: string, organizationId: string) {
    const rows = await this.db.select({ companyId: sourceRecords.companyId }).from(sourceRecords)
      .where(and(eq(sourceRecords.searchExecutionId, searchExecutionId), eq(sourceRecords.organizationId, organizationId)));
    return [...new Set(rows.map((row) => row.companyId).filter((id): id is string => Boolean(id)))];
  }

  private async findExecution(searchExecutionId: string, organizationId: string) {
    const [execution] = await this.db.select().from(searchExecutions)
      .where(and(eq(searchExecutions.id, searchExecutionId), eq(searchExecutions.organizationId, organizationId))).limit(1);
    if (!execution) throw new NotFoundException('Search execution not found');
    return execution;
  }

  private asPlan(value: unknown): SearchPlan {
    return typeof value === 'object' && value !== null ? value as SearchPlan : {
      industry: [],
      leadTypes: [],
      locations: [],
      companyFields: [],
      unresolvedCriteria: [],
    };
  }

  private criteriaHash(value: unknown) {
    return createHash('sha256').update(JSON.stringify(value ?? {})).digest('hex').slice(0, 24);
  }

  private audit(organizationId: string, entityId: string, action: string, metadata: unknown) {
    return this.db.insert(auditLogs).values({ organizationId, entityId, action, entityType: 'qualification', metadata });
  }
}
