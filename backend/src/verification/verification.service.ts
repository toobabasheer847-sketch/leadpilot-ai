import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, desc, eq, isNull, like, max } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { DRIZZLE } from '../database/database.constants';
import type { Database } from '../database/database.types';
import { auditLogs, companies, companyContacts, companyLocations, companySocialProfiles, leadEvidence, leadVerifications, searchExecutions, sourceRecords, verificationConflicts } from '../database/schema/schema';
import { VerificationQueue } from './verification.queue';
import {
  EMAIL_VERIFICATION_PROVIDER,
  PHONE_VERIFICATION_PROVIDER,
  SOCIAL_VERIFICATION_PROVIDER,
  WEBSITE_VERIFICATION_PROVIDER,
} from './providers/verification-provider.interface';
import type { VerificationProvider } from './providers/verification-provider.interface';
import type { VerificationConflictLog, VerificationEvidence, VerificationInput, VerificationJobData, VerificationResult, VerificationSignal } from './types/verification.types';
import { normalizeState } from './utils/location-normalizer';
import { UsageService } from '../usage/usage.service';
import { ConflictEngineService } from './conflict/conflict-engine.service';
import { CrossSourceEntityMatcherService } from './matching/cross-source-entity-matcher.service';
import type { SearchPlan } from '../search/types/search-plan.types';
import { companyFieldsForVerification, fieldIsRequiredByPlan, personFieldsForVerification } from './plan-verification-fields';
import { isGenericBusinessEmail } from './utils/generic-email';
import { assessPersonEmailOwnership } from './utils/email-ownership';
import { summarizeAggregateVerification } from './utils/aggregate-verification';
import { countIndependentSources } from './utils/source-independence';

@Injectable()
export class VerificationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly queue: VerificationQueue,
    @Inject(EMAIL_VERIFICATION_PROVIDER) private readonly emailProvider: VerificationProvider,
    @Inject(PHONE_VERIFICATION_PROVIDER) private readonly phoneProvider: VerificationProvider,
    @Inject(WEBSITE_VERIFICATION_PROVIDER) private readonly websiteProvider: VerificationProvider,
    @Inject(SOCIAL_VERIFICATION_PROVIDER) private readonly socialProvider: VerificationProvider,
    private readonly usage: UsageService,
    private readonly config: ConfigService,
    private readonly conflictEngine: ConflictEngineService,
    private readonly entityMatcher: CrossSourceEntityMatcherService,
  ) {}

  async enqueueCompany(companyId: string, organizationId: string, force = false, searchExecutionId: string | null = null) {
    await this.findCompany(companyId, organizationId);
    return this.enqueue(companyId, null, organizationId, force, searchExecutionId);
  }

  async enqueueContact(contactId: string, organizationId: string, force = false, searchExecutionId: string | null = null) {
    const contact = await this.findContact(contactId, organizationId);
    return this.enqueue(contact.companyId, contactId, organizationId, force, searchExecutionId);
  }

  async listCompany(companyId: string, organizationId: string) {
    await this.findCompany(companyId, organizationId);
    return this.db.select().from(leadVerifications)
      .where(and(eq(leadVerifications.companyId, companyId), eq(leadVerifications.organizationId, organizationId), isNull(leadVerifications.contactId)))
      .orderBy(desc(leadVerifications.checkedAt));
  }

  async listContact(contactId: string, organizationId: string) {
    const contact = await this.findContact(contactId, organizationId);
    return this.db.select().from(leadVerifications)
      .where(and(eq(leadVerifications.contactId, contact.id), eq(leadVerifications.organizationId, organizationId)))
      .orderBy(desc(leadVerifications.checkedAt));
  }

  async summaryCompany(companyId: string, organizationId: string) {
    const company = await this.findCompany(companyId, organizationId);
    const contacts = await this.db.select().from(companyContacts).where(eq(companyContacts.companyId, companyId));
    const verifications = await this.db.select().from(leadVerifications).where(and(eq(leadVerifications.companyId, companyId), eq(leadVerifications.organizationId, organizationId))).orderBy(desc(leadVerifications.checkedAt));
    const evidence = await this.db.select().from(leadEvidence).where(eq(leadEvidence.companyId, companyId));
    const conflicts = await this.db.select().from(verificationConflicts).where(and(eq(verificationConflicts.companyId, companyId), eq(verificationConflicts.organizationId, organizationId), eq(verificationConflicts.requiresReview, true))).orderBy(desc(verificationConflicts.createdAt));
    const fields = this.latestFieldBreakdown(verifications);
    const aggregate = summarizeAggregateVerification(fields.map((row) => ({
      field: row.fieldName,
      status: row.status,
      metadata: typeof row.metadata === 'object' && row.metadata !== null ? row.metadata as Record<string, unknown> : null,
    })));
    const now = new Date();
    return {
      company,
      people: contacts,
      verificationStatus: aggregate.aggregateStatus,
      verificationSummary: aggregate,
      fields,
      evidenceCount: evidence.length,
      sourceCount: countIndependentSources(evidence.map((row) => ({
        sourceUrl: row.canonicalUrl ?? row.sourceUrl,
        provider: row.provider,
        sourceType: row.sourceType,
      }))),
      conflicts,
      requiresReview: conflicts.length > 0 || aggregate.flags.needsReview,
      lastVerifiedAt: company.lastVerifiedAt ?? verifications[0]?.checkedAt ?? null,
      nextReverificationAt: company.nextReverificationAt ?? null,
      reVerificationDue: company.nextReverificationAt ? company.nextReverificationAt <= now : false,
    };
  }

  async getById(verificationId: string, organizationId: string) {
    const [result] = await this.db.select().from(leadVerifications)
      .where(and(eq(leadVerifications.id, verificationId), eq(leadVerifications.organizationId, organizationId))).limit(1);
    if (!result) throw new NotFoundException('Verification not found');
    return result;
  }

  verifyQueued(data: VerificationJobData) {
    return this.runVerification(data);
  }

  private async enqueue(companyId: string, contactId: string | null, organizationId: string, force: boolean, searchExecutionId: string | null) {
    await this.usage.checkRequestRate(organizationId, undefined, 'VERIFICATION');
    const company = await this.findCompany(companyId, organizationId);
    if (!force && company.nextReverificationAt && company.nextReverificationAt > new Date()) {
      const [latestEvidence] = await this.db.select({ retrievedAt: max(leadEvidence.evidenceTimestamp) }).from(leadEvidence).where(and(eq(leadEvidence.companyId, companyId), contactId ? eq(leadEvidence.contactId, contactId) : isNull(leadEvidence.contactId)));
      const version = latestEvidence?.retrievedAt?.toISOString() ?? 'empty';
      const baseKey = this.buildKey(organizationId, companyId, contactId, version);
      const [existing] = await this.db.select({ id: leadVerifications.id }).from(leadVerifications)
        .where(and(eq(leadVerifications.organizationId, organizationId), like(leadVerifications.idempotencyKey, `${baseKey}:%`))).limit(1);
      if (existing) return { status: 'EXISTS' as const, verificationId: existing.id, nextReverificationAt: company.nextReverificationAt };
    }
    const [latestEvidence] = await this.db.select({ retrievedAt: max(leadEvidence.evidenceTimestamp) }).from(leadEvidence).where(and(eq(leadEvidence.companyId, companyId), contactId ? eq(leadEvidence.contactId, contactId) : isNull(leadEvidence.contactId)));
    const version = force ? Date.now().toString() : latestEvidence?.retrievedAt?.toISOString() ?? 'empty';
    const baseKey = this.buildKey(organizationId, companyId, contactId, version);
    if (!force) {
      const [existing] = await this.db.select({ id: leadVerifications.id }).from(leadVerifications)
        .where(and(eq(leadVerifications.organizationId, organizationId), like(leadVerifications.idempotencyKey, `${baseKey}:%`))).limit(1);
      if (existing) return { status: 'EXISTS' as const, verificationId: existing.id };
    }
    const job = await this.queue.enqueue({ companyId, contactId, organizationId, searchExecutionId, force, idempotencyKey: baseKey });
    await this.audit(organizationId, companyId, 'MULTI_SOURCE_VERIFICATION_STARTED', { jobId: job.id, contactId });
    return { status: 'QUEUED' as const, jobId: job.id };
  }

  private async runVerification(data: VerificationJobData) {
    const company = await this.findCompany(data.companyId, data.organizationId);
    const contact = data.contactId ? await this.findContact(data.contactId, data.organizationId) : null;
    const plan = await this.loadPlan(data.searchExecutionId, data.organizationId);
    const evidence = await this.loadEvidence(company.id, contact?.id ?? null);
    const entityMatch = data.contactId ? null : await this.matchCrossSourceEntities(company.id, data.organizationId);
    const rows = data.contactId
      ? await this.verifyContactFields(company, contact!, evidence, data, plan)
      : await this.verifyCompanyFields(company, evidence, data, entityMatch?.conflicts ?? [], plan);
    const conflictCount = rows.filter((row) => row.status === 'CONFLICT' || row.status === 'NEEDS_REVIEW').length + (entityMatch?.conflicts.length ?? 0);
    await this.usage.recordUsage({ organizationId: data.organizationId, operation: 'VERIFICATION', provider: 'stored-evidence', resourceType: data.contactId ? 'contact' : 'company', resourceId: data.contactId ?? data.companyId, units: Math.max(1, rows.length), status: 'COMPLETED', metadata: { conflicts: conflictCount } });
    if (contact) {
      await this.updateContactQuality(contact.id, rows.map((row) => ({
        field: row.field,
        value: row.fieldValue,
        status: row.status,
        metadata: typeof row.metadata === 'object' && row.metadata !== null ? row.metadata as Record<string, unknown> : null,
      })));
    } else await this.updateCompanyQuality(company.id, rows.map((row) => row.status), entityMatch);
    await this.audit(data.organizationId, company.id, 'MULTI_SOURCE_VERIFICATION_COMPLETED', { contactId: data.contactId, count: rows.length, conflicts: conflictCount, sameEntity: entityMatch?.sameEntity ?? null });
    return rows;
  }

  private async verifyCompanyFields(company: typeof companies.$inferSelect, evidence: VerificationEvidence[], data: VerificationJobData, entityConflicts: VerificationConflictLog[], plan: SearchPlan | null) {
    const [location] = await this.db.select().from(companyLocations).where(eq(companyLocations.companyId, company.id)).limit(1);
    const socialProfiles = await this.db.select().from(companySocialProfiles).where(eq(companySocialProfiles.companyId, company.id));
    const allowed = new Set(companyFieldsForVerification(plan, socialProfiles.map((profile) => profile.platform)));
    const allFields: Array<{ field: string; value: string | null; provider?: VerificationProvider }> = [
      { field: 'companyName', value: company.name },
      { field: 'website', value: company.website, provider: this.websiteProvider },
      { field: 'description', value: company.description },
      { field: 'phone', value: company.phone, provider: this.phoneProvider },
      { field: 'email', value: company.email, provider: this.emailProvider },
      { field: 'category', value: company.category },
      { field: 'investorType', value: company.investorType },
      { field: 'investmentStrategy', value: company.investmentStrategy },
      { field: 'companySize', value: company.employeeCount?.toString() ?? company.employeeRange },
      { field: 'city', value: location?.city ?? null },
      { field: 'state', value: location?.state ? normalizeState(location.state) : null },
      { field: 'zip', value: location?.postalCode ?? null },
      { field: 'country', value: location?.country ?? null },
    ];
    for (const profile of socialProfiles) allFields.push({ field: profile.platform, value: profile.profileUrl, provider: this.socialProvider });
    const fields = allFields.filter((field) => allowed.has(field.field));
    const results = await this.evaluateFields(fields, evidence, plan);
    for (const conflict of entityConflicts) {
      await this.persistConflict(data, conflict);
      const existing = results.find((row) => row.field === conflict.fieldName);
      if (existing && existing.status !== 'NEEDS_REVIEW' && existing.status !== 'CONFLICT') {
        existing.status = 'NEEDS_REVIEW';
        existing.verificationType = 'CROSS_SOURCE_MATCH';
        existing.conflict = conflict;
        existing.metadata = { ...existing.metadata, requiresReview: true, conflict };
      } else if (!existing) {
        results.push({
          field: conflict.fieldName,
          value: (company[conflict.fieldName as keyof typeof company] as string | null | undefined) ?? conflict.valueA,
          status: 'NEEDS_REVIEW',
          verificationType: 'CROSS_SOURCE_MATCH',
          provider: 'stored-evidence',
          conflict,
          metadata: { requiresReview: true, conflict },
          checkedAt: new Date().toISOString(),
        });
      }
    }
    return this.persistResults(data, results);
  }

  private async verifyContactFields(company: typeof companies.$inferSelect, contact: typeof companyContacts.$inferSelect, evidence: VerificationEvidence[], data: VerificationJobData, plan: SearchPlan | null) {
    const allowed = new Set(personFieldsForVerification(plan));
    const genericPersonEmail = Boolean(contact.email && isGenericBusinessEmail(contact.email));
    const personEmail = genericPersonEmail ? null : contact.email;
    const allFields: Array<{ field: string; value: string | null; provider?: VerificationProvider }> = [
      { field: 'fullName', value: contact.fullName },
      { field: 'title', value: contact.title },
      { field: 'companyRelationship', value: contact.companyRelationship ?? company.name },
      { field: 'email', value: personEmail, provider: this.emailProvider },
      { field: 'phone', value: contact.phone, provider: this.phoneProvider },
      { field: 'linkedin', value: contact.linkedinUrl, provider: this.socialProvider },
      { field: 'facebook', value: contact.facebookUrl, provider: this.socialProvider },
      { field: 'instagram', value: contact.instagramUrl, provider: this.socialProvider },
      { field: 'youtube', value: contact.youtubeUrl, provider: this.socialProvider },
      { field: 'normalizedRole', value: contact.normalizedRole },
    ];
    const fields = allFields.filter((field) => allowed.has(field.field));
    const results = await this.evaluateFields(fields, evidence, plan);
    if (genericPersonEmail && allowed.has('email')) {
      const emailResult = results.find((row) => row.field === 'email');
      if (emailResult) {
        emailResult.value = null;
        emailResult.status = 'NOT_FOUND';
        emailResult.metadata = {
          ...emailResult.metadata,
          companyLevelOnly: true,
          rejectedGenericMailbox: contact.email,
          ownershipVerified: false,
          verificationKind: 'syntax',
        };
      }
    } else {
      this.applyPersonEmailOwnership(results, personEmail, contact.fullName, evidence);
    }
    return this.persistResults(data, results);
  }

  /** Person ownership is never inferred from deliverability or source-count alone. */
  private applyPersonEmailOwnership(
    results: VerificationResult[],
    email: string | null,
    personName: string | null,
    evidence: VerificationEvidence[],
  ) {
    const emailResult = results.find((row) => row.field === 'email');
    if (!emailResult) return;
    const deliverabilityVerified = Boolean(emailResult.metadata?.deliverabilityVerified);
    const ownership = assessPersonEmailOwnership({
      email,
      personName,
      evidence,
      evidenceStatus: (emailResult.metadata?.evidenceStatus as string | undefined) ?? emailResult.status,
      deliverabilityVerified,
    });
    emailResult.metadata = {
      ...emailResult.metadata,
      ownershipVerified: ownership.ownershipVerified,
      ownershipSourceCount: ownership.ownershipSourceCount,
      deliverabilityVerified,
      verificationKind: ownership.ownershipVerified
        ? 'ownership'
        : (emailResult.metadata?.verificationKind as string | undefined)
          ?? ownership.verificationKind,
    };
  }

  private async evaluateFields(fields: Array<{ field: string; value: string | null; provider?: VerificationProvider }>, evidence: VerificationEvidence[], plan: SearchPlan | null) {
    const results: VerificationResult[] = [];
    const seen = new Set<string>();
    for (const field of fields) {
      if (seen.has(field.field)) continue;
      seen.add(field.field);
      const input: VerificationInput = { field: field.field, value: field.value, evidence };
      const evidenceSignal = this.conflictEngine.evaluateField(input, (item) => this.sourcePriority(item));
      const providerSignal = field.provider ? await field.provider.verify(input) : evidenceSignal;
      let signal = this.mergeSignals(evidenceSignal, providerSignal);

      // Required-by-plan missing fields stay NOT_FOUND (qualification handles review); never invent values.
      if (!field.value && fieldIsRequiredByPlan(plan, field.field)) {
        signal = { ...signal, status: 'NOT_FOUND', metadata: { ...signal.metadata, requiredByPlan: true } };
      }

      if (providerSignal.metadata?.genericMailbox && field.field === 'email') {
        signal = {
          ...signal,
          status: signal.status === 'NOT_FOUND' ? 'NOT_FOUND' : 'UNVERIFIED',
          metadata: { ...signal.metadata, ...providerSignal.metadata, companyLevelOnly: true },
        };
      }

      results.push({ field: field.field, value: field.value, ...signal, checkedAt: new Date().toISOString() });
    }
    return results;
  }

  /** Evidence/conflict engine wins on conflicts and multi-source confirmation; providers can upgrade deliverability only. */
  private mergeSignals(evidenceSignal: VerificationSignal, providerSignal: VerificationSignal): VerificationSignal {
    if (evidenceSignal.status === 'NEEDS_REVIEW' || evidenceSignal.status === 'CONFLICT') {
      return {
        ...evidenceSignal,
        provider: providerSignal.provider || evidenceSignal.provider,
        metadata: {
          ...evidenceSignal.metadata,
          ...providerSignal.metadata,
          ownershipVerified: false,
          deliverabilityVerified: Boolean(providerSignal.metadata?.deliverabilityVerified),
        },
      };
    }
    if (evidenceSignal.status === 'VERIFIED') {
      return {
        ...evidenceSignal,
        provider: providerSignal.provider || evidenceSignal.provider,
        metadata: {
          ...evidenceSignal.metadata,
          ...providerSignal.metadata,
          // Never promote multi-source agreement to person ownership here.
          ownershipVerified: false,
          deliverabilityVerified: Boolean(providerSignal.metadata?.deliverabilityVerified),
          verificationKind: evidenceSignal.metadata?.verificationKind
            ?? (providerSignal.metadata?.deliverabilityVerified ? 'independent_evidence' : 'independent_evidence'),
        },
      };
    }
    if (providerSignal.status === 'INVALID') return { ...providerSignal, conflict: evidenceSignal.conflict, metadata: { ...providerSignal.metadata, ownershipVerified: false } };
    // ZeroBounce (or similar) deliverability VERIFIED is preserved, but ownership stays false.
    if (providerSignal.status === 'VERIFIED' && (evidenceSignal.status === 'SUPPORTED' || evidenceSignal.status === 'UNVERIFIED' || evidenceSignal.status === 'FOUND')) {
      return {
        ...providerSignal,
        evidenceId: evidenceSignal.evidenceId ?? providerSignal.evidenceId,
        provenance: evidenceSignal.provenance ?? providerSignal.provenance,
        metadata: {
          ...evidenceSignal.metadata,
          ...providerSignal.metadata,
          evidenceStatus: evidenceSignal.status,
          ownershipVerified: false,
          deliverabilityVerified: providerSignal.metadata?.deliverabilityVerified ?? true,
          verificationKind: providerSignal.metadata?.verificationKind ?? 'deliverability',
        },
      };
    }
    if (evidenceSignal.status === 'SUPPORTED') {
      return {
        ...evidenceSignal,
        provider: providerSignal.provider || evidenceSignal.provider,
        metadata: {
          ...evidenceSignal.metadata,
          ...providerSignal.metadata,
          ownershipVerified: false,
          deliverabilityVerified: providerSignal.metadata?.deliverabilityVerified ?? false,
          verificationKind: 'evidence_supported',
        },
      };
    }
    return {
      ...providerSignal,
      evidenceId: evidenceSignal.evidenceId ?? providerSignal.evidenceId,
      provenance: evidenceSignal.provenance ?? providerSignal.provenance,
      metadata: {
        ...evidenceSignal.metadata,
        ...providerSignal.metadata,
        ownershipVerified: false,
        deliverabilityVerified: providerSignal.metadata?.deliverabilityVerified ?? false,
      },
    };
  }

  private async persistResults(data: VerificationJobData, results: VerificationResult[]) {
    const stored = [];
    for (const result of results) {
      if (result.conflict) await this.persistConflict(data, result.conflict);
      const status = result.status === 'NEEDS_REVIEW' ? 'NEEDS_REVIEW' : result.status;
      const idempotencyKey = `${data.idempotencyKey}:${result.field}`;
      const [row] = await this.db.insert(leadVerifications).values({
        companyId: data.companyId,
        contactId: data.contactId,
        organizationId: data.organizationId,
        fieldName: result.field,
        field: result.field,
        fieldValue: result.value,
        verificationStatus: status === 'NEEDS_REVIEW' ? 'CONFLICT' : status,
        status,
        verificationType: result.verificationType,
        provider: result.provider,
        evidenceId: result.evidenceId ?? null,
        confidence: result.confidence?.toFixed(4) ?? null,
        checkedAt: new Date(result.checkedAt),
        metadata: {
          ...result.metadata,
          requiresReview: status === 'NEEDS_REVIEW' || status === 'CONFLICT',
          provenance: result.provenance ?? null,
        },
        idempotencyKey,
        verificationSource: result.provenance?.sourceType ?? result.provider,
        verificationUrl: result.provenance?.sourceUrl ?? null,
        verifiedAt: status === 'VERIFIED' || status === 'SUPPORTED' ? new Date(result.checkedAt) : null,
        notes: result.provenance?.evidenceExcerpt ?? null,
      }).onConflictDoNothing({ target: [leadVerifications.organizationId, leadVerifications.idempotencyKey] }).returning();
      if (row) stored.push(row);
    }
    return stored;
  }

  private async persistConflict(data: VerificationJobData, conflict: VerificationConflictLog) {
    const idempotencyKey = this.conflictEngine.conflictIdempotencyKey(data.organizationId, data.companyId, data.contactId, conflict);
    await this.db.insert(verificationConflicts).values({
      organizationId: data.organizationId,
      companyId: data.companyId,
      contactId: data.contactId,
      fieldName: conflict.fieldName,
      valueA: conflict.valueA,
      valueB: conflict.valueB,
      sourceTypeA: conflict.sourceTypeA,
      sourceUrlA: conflict.sourceUrlA,
      retrievedAtA: conflict.retrievedAtA,
      evidenceExcerptA: conflict.evidenceExcerptA,
      sourceTypeB: conflict.sourceTypeB,
      sourceUrlB: conflict.sourceUrlB,
      retrievedAtB: conflict.retrievedAtB,
      evidenceExcerptB: conflict.evidenceExcerptB,
      status: 'CONFLICT',
      requiresReview: true,
      resolutionStatus: 'OPEN',
      idempotencyKey,
    }).onConflictDoNothing({ target: [verificationConflicts.organizationId, verificationConflicts.idempotencyKey] });
  }

  private async matchCrossSourceEntities(companyId: string, organizationId: string) {
    const sources = await this.db.select().from(sourceRecords).where(and(eq(sourceRecords.companyId, companyId), eq(sourceRecords.organizationId, organizationId)));
    const claims = sources.map((source) => this.entityMatcher.extractClaim(source));
    return this.entityMatcher.match(claims);
  }

  private async loadEvidence(companyId: string, contactId: string | null) {
    const rows = await this.db.select({
      id: leadEvidence.id,
      sourceUrl: leadEvidence.sourceUrl,
      evidenceType: leadEvidence.evidenceType,
      evidenceText: leadEvidence.evidenceText,
      metadata: leadEvidence.metadata,
      retrievedAt: leadEvidence.evidenceTimestamp,
      canonicalUrl: leadEvidence.canonicalUrl,
      sourceType: leadEvidence.sourceType,
      provider: leadEvidence.provider,
    }).from(leadEvidence).where(and(eq(leadEvidence.companyId, companyId), contactId ? eq(leadEvidence.contactId, contactId) : isNull(leadEvidence.contactId)));
    return rows;
  }

  private async findCompany(companyId: string, organizationId: string) {
    const [company] = await this.db.select().from(companies).where(and(eq(companies.id, companyId), eq(companies.organizationId, organizationId))).limit(1);
    if (!company) throw new NotFoundException('Company not found');
    return company;
  }

  private async findContact(contactId: string, organizationId: string) {
    const [contact] = await this.db.select({ contact: companyContacts }).from(companyContacts).innerJoin(companies, eq(companies.id, companyContacts.companyId)).where(and(eq(companyContacts.id, contactId), eq(companies.organizationId, organizationId))).limit(1);
    if (!contact) throw new NotFoundException('Contact not found');
    return contact.contact;
  }

  private buildKey(organizationId: string, companyId: string, contactId: string | null, version: string) {
    return createHash('sha256').update(JSON.stringify({ organizationId, companyId, contactId, version })).digest('hex');
  }

  private audit(organizationId: string, entityId: string, action: string, metadata: unknown) {
    return this.db.insert(auditLogs).values({ organizationId, entityId, action, entityType: 'verification', metadata });
  }

  private sourcePriority(item: VerificationEvidence) {
    const priorities = this.config.get<Record<string, unknown>>('verification.sourcePriorities', {});
    const value = priorities[item.provider ?? item.sourceType ?? ''] ?? 0;
    return Number.isFinite(Number(value)) ? Number(value) : 0;
  }

  private latestFieldBreakdown(verifications: Array<typeof leadVerifications.$inferSelect>) {
    const latest = new Map<string, typeof leadVerifications.$inferSelect>();
    for (const row of verifications) {
      const key = `${row.contactId ?? 'company'}:${row.fieldName || row.field}`;
      if (!latest.has(key)) latest.set(key, row);
    }
    return [...latest.values()].map((row) => ({
      fieldName: row.fieldName || row.field,
      fieldValue: row.fieldValue,
      status: row.status,
      verificationStatus: row.verificationStatus,
      contactId: row.contactId,
      confidence: row.confidence,
      checkedAt: row.checkedAt,
      provenance: {
        sourceType: row.verificationSource,
        sourceUrl: row.verificationUrl,
        retrievedAt: row.verifiedAt,
        evidenceExcerpt: row.notes,
      },
      metadata: row.metadata,
    }));
  }

  private async updateCompanyQuality(companyId: string, statuses: string[], entityMatch: { sameEntity: boolean; confidence: number } | null) {
    const days = this.config.get<number>('verification.reVerifyAfterDays', 30);
    const now = new Date();
    const next = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
    const aggregate = summarizeAggregateVerification(statuses.map((status) => ({ field: 'field', status })));
    const status = aggregate.aggregateStatus;
    await this.db.update(companies).set({
      verificationStatus: status === 'NEEDS_REVIEW' ? 'NEEDS_REVIEW'
        : status === 'VERIFIED' ? 'VERIFIED'
          : status === 'PARTIALLY_VERIFIED' || status === 'SUPPORTED' ? 'PARTIALLY_VERIFIED'
            : status === 'NOT_FOUND' ? 'NOT_FOUND'
              : 'UNVERIFIED',
      lastVerifiedAt: now,
      nextReverificationAt: next,
      updatedAt: now,
    }).where(eq(companies.id, companyId));
    void entityMatch;
  }

  private async updateContactQuality(contactId: string, rows: Array<{ field: string; value: string | null; status: string; metadata?: Record<string, unknown> | null }>) {
    const conflict = rows.some((row) => row.status === 'CONFLICT' || row.status === 'NEEDS_REVIEW');
    const coreFields = ['fullName', 'title', 'companyRelationship'];
    const coreVerified = coreFields.every((field) => rows.some((row) => row.field === field && (row.status === 'VERIFIED' || row.status === 'SUPPORTED')));
    const email = rows.find((row) => row.field === 'email');
    const phone = rows.find((row) => row.field === 'phone');
    await this.db.update(companyContacts).set({
      verificationStatus: conflict ? 'NEEDS_REVIEW' : coreVerified ? 'VERIFIED' : 'PARTIALLY_VERIFIED',
      status: conflict ? 'NOT_VERIFIED' : coreVerified ? 'VERIFIED' : 'PARTIALLY_VERIFIED',
      emailStatus: this.contactChannelStatus(email),
      phoneStatus: this.contactChannelStatus(phone),
      lastVerifiedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(companyContacts.id, contactId));
  }

  private contactChannelStatus(row?: { field: string; value: string | null; status: string; metadata?: Record<string, unknown> | null }) {
    if (!row || row.status === 'NOT_FOUND' || !row.value) return 'NOT_FOUND';
    if (row.status === 'CONFLICT' || row.status === 'NEEDS_REVIEW') return 'NEEDS_REVIEW';
    if (row.status === 'INVALID') return 'NOT_FOUND';
    if (row.field === 'email') {
      if (row.metadata?.ownershipVerified === true) return 'PERSON_OWNERSHIP_VERIFIED';
      if (row.metadata?.deliverabilityVerified === true) return 'DELIVERABILITY_VERIFIED';
      if (row.status === 'VERIFIED') return 'EVIDENCE_VERIFIED';
      if (row.status === 'SUPPORTED') return 'SUPPORTED';
      if (row.metadata?.verificationKind === 'syntax') return 'SYNTAX_VALID';
      if (row.status === 'FOUND') return 'FOUND';
      return 'UNVERIFIED';
    }
    if (row.status === 'VERIFIED') return 'VERIFIED';
    if (row.status === 'SUPPORTED') return 'SUPPORTED';
    if (row.status === 'FOUND') return 'FOUND';
    return 'UNVERIFIED';
  }

  private async loadPlan(searchExecutionId: string | null | undefined, organizationId: string): Promise<SearchPlan | null> {
    if (!searchExecutionId) return null;
    const [row] = await this.db.select({ plan: searchExecutions.structuredPlan }).from(searchExecutions).where(and(
      eq(searchExecutions.id, searchExecutionId),
      eq(searchExecutions.organizationId, organizationId),
    )).limit(1);
    return row?.plan && typeof row.plan === 'object' ? row.plan as SearchPlan : null;
  }
}
