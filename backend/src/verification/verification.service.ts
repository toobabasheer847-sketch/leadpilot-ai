import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, isNull, like } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { DRIZZLE } from '../database/database.constants';
import type { Database } from '../database/database.types';
import { auditLogs, companies, companyContacts, companyLocations, companySocialProfiles, leadEvidence, leadVerifications } from '../database/schema/schema';
import { VerificationQueue } from './verification.queue';
import {
  EMAIL_VERIFICATION_PROVIDER,
  PHONE_VERIFICATION_PROVIDER,
  SOCIAL_VERIFICATION_PROVIDER,
  WEBSITE_VERIFICATION_PROVIDER,
} from './providers/verification-provider.interface';
import type { VerificationProvider } from './providers/verification-provider.interface';
import type { VerificationEvidence, VerificationInput, VerificationJobData, VerificationResult, VerificationSignal } from './types/verification.types';
import { normalizeState } from './utils/location-normalizer';

@Injectable()
export class VerificationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly queue: VerificationQueue,
    @Inject(EMAIL_VERIFICATION_PROVIDER) private readonly emailProvider: VerificationProvider,
    @Inject(PHONE_VERIFICATION_PROVIDER) private readonly phoneProvider: VerificationProvider,
    @Inject(WEBSITE_VERIFICATION_PROVIDER) private readonly websiteProvider: VerificationProvider,
    @Inject(SOCIAL_VERIFICATION_PROVIDER) private readonly socialProvider: VerificationProvider,
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
    const baseKey = this.buildKey(organizationId, companyId, contactId, force ? Date.now().toString() : 'current');
    if (!force) {
      const [existing] = await this.db.select({ id: leadVerifications.id }).from(leadVerifications)
        .where(and(eq(leadVerifications.organizationId, organizationId), like(leadVerifications.idempotencyKey, `${baseKey}:%`))).limit(1);
      if (existing) return { status: 'EXISTS' as const, verificationId: existing.id };
    }
    const job = await this.queue.enqueue({ companyId, contactId, organizationId, searchExecutionId, force, idempotencyKey: baseKey });
    await this.audit(organizationId, companyId, 'LEAD_VERIFICATION_STARTED', { jobId: job.id, contactId });
    return { status: 'QUEUED' as const, jobId: job.id };
  }

  private async runVerification(data: VerificationJobData) {
    const company = await this.findCompany(data.companyId, data.organizationId);
    const contact = data.contactId ? await this.findContact(data.contactId, data.organizationId) : null;
    const evidence = await this.loadEvidence(company.id, contact?.id ?? null);
    const rows = data.contactId
      ? await this.verifyContactFields(company, contact!, evidence, data)
      : await this.verifyCompanyFields(company, evidence, data);
    await this.audit(data.organizationId, company.id, 'LEAD_VERIFICATION_COMPLETED', { contactId: data.contactId, count: rows.length });
    return rows;
  }

  private async verifyCompanyFields(company: typeof companies.$inferSelect, evidence: VerificationEvidence[], data: VerificationJobData) {
    const [location] = await this.db.select().from(companyLocations).where(eq(companyLocations.companyId, company.id)).limit(1);
    const fields: Array<{ field: string; value: string | null; provider?: VerificationProvider }> = [
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
    const socialProfiles = await this.db.select().from(companySocialProfiles).where(eq(companySocialProfiles.companyId, company.id));
    for (const profile of socialProfiles) fields.push({ field: profile.platform, value: profile.profileUrl, provider: this.socialProvider });
    return this.persistResults(data, await this.evaluateFields(fields, evidence));
  }

  private async verifyContactFields(company: typeof companies.$inferSelect, contact: typeof companyContacts.$inferSelect, evidence: VerificationEvidence[], data: VerificationJobData) {
    const fields: Array<{ field: string; value: string | null; provider?: VerificationProvider }> = [
      { field: 'fullName', value: contact.fullName },
      { field: 'title', value: contact.title },
      { field: 'companyAssociation', value: company.name },
      { field: 'email', value: contact.email, provider: this.emailProvider },
      { field: 'phone', value: contact.phone, provider: this.phoneProvider },
      { field: 'linkedin', value: contact.linkedinUrl, provider: this.socialProvider },
      { field: 'facebook', value: contact.facebookUrl, provider: this.socialProvider },
      { field: 'instagram', value: contact.instagramUrl, provider: this.socialProvider },
      { field: 'youtube', value: contact.youtubeUrl, provider: this.socialProvider },
      { field: 'normalizedRole', value: contact.normalizedRole },
      { field: 'companyRelationship', value: contact.companyRelationship },
    ];
    return this.persistResults(data, await this.evaluateFields(fields, evidence));
  }

  private async evaluateFields(fields: Array<{ field: string; value: string | null; provider?: VerificationProvider }>, evidence: VerificationEvidence[]) {
    const results: VerificationResult[] = [];
    for (const field of fields) {
      const input: VerificationInput = { field: field.field, value: field.value, evidence };
      const signal = field.provider ? await field.provider.verify(input) : this.localEvidenceSignal(input);
      results.push({ field: field.field, value: field.value, ...signal, checkedAt: new Date().toISOString() });
    }
    return results;
  }

  private localEvidenceSignal(input: VerificationInput): VerificationSignal {
    if (!input.value) return { status: 'NOT_FOUND', verificationType: 'SOURCE_EVIDENCE', provider: 'stored-evidence' };
    const fieldEvidence = input.evidence.filter((item) => this.metadata(item).field === input.field);
    const fieldValues = new Set(fieldEvidence.map((item) => this.evidenceValue(item)).filter((value): value is string => Boolean(value)).map((value) => this.normalize(input.field, value)));
    if (fieldValues.size > 1) {
      return {
        status: 'CONFLICT',
        verificationType: 'CROSS_SOURCE_MATCH',
        provider: 'stored-evidence',
        metadata: { evidenceIds: fieldEvidence.map((item) => item.id) },
      };
    }
    const matches = input.evidence.filter((item) => this.evidenceMatches(item, input.field, input.value!));
    const distinctValues = new Set(matches.map((item) => this.evidenceValue(item) ?? input.value));
    if (distinctValues.size > 1) return { status: 'CONFLICT', verificationType: 'CROSS_SOURCE_MATCH', provider: 'stored-evidence', metadata: { evidenceIds: matches.map((item) => item.id) } };
    if (matches[0]) return { status: 'SUPPORTED', verificationType: 'SOURCE_EVIDENCE', provider: 'stored-evidence', evidenceId: matches[0].id, confidence: 0.75 };
    return { status: 'UNVERIFIED', verificationType: 'SOURCE_EVIDENCE', provider: 'stored-evidence' };
  }

  private evidenceMatches(item: VerificationEvidence, field: string, value: string) {
    const metadata = this.metadata(item);
    if (metadata.field === field && typeof metadata.value === 'string') return this.normalize(field, metadata.value) === this.normalize(field, value);
    if (field === 'email') return item.evidenceText.toLowerCase().includes(value.toLowerCase());
    if (field === 'phone') return item.evidenceText.replace(/\D/g, '').includes(value.replace(/\D/g, ''));
    return item.evidenceText.toLowerCase().includes(value.toLowerCase());
  }

  private evidenceValue(item: VerificationEvidence) {
    const value = this.metadata(item).value;
    return typeof value === 'string' ? value : null;
  }

  private normalize(field: string, value: string) {
    return field === 'email' ? value.toLowerCase().trim() : field === 'phone' ? value.replace(/\D/g, '') : value.toLowerCase().trim();
  }

  private metadata(item: VerificationEvidence) {
    return typeof item.metadata === 'object' && item.metadata !== null ? item.metadata as Record<string, unknown> : {};
  }

  private async persistResults(data: VerificationJobData, results: VerificationResult[]) {
    const stored = [];
    for (const result of results) {
      const idempotencyKey = `${data.idempotencyKey}:${result.field}`;
      const [row] = await this.db.insert(leadVerifications).values({
        companyId: data.companyId,
        contactId: data.contactId,
        organizationId: data.organizationId,
        fieldName: result.field,
        field: result.field,
        fieldValue: result.value,
        verificationStatus: result.status,
        status: result.status,
        verificationType: result.verificationType,
        provider: result.provider,
        evidenceId: result.evidenceId ?? null,
        confidence: result.confidence?.toFixed(4) ?? null,
        checkedAt: new Date(result.checkedAt),
        metadata: result.metadata ?? null,
        idempotencyKey,
        verificationSource: result.provider,
        verificationUrl: null,
        verifiedAt: result.status === 'VERIFIED' || result.status === 'SUPPORTED' ? new Date(result.checkedAt) : null,
        notes: null,
      }).returning();
      if (row) stored.push(row);
    }
    return stored;
  }

  private async loadEvidence(companyId: string, contactId: string | null) {
    const rows = await this.db.select({
      id: leadEvidence.id,
      sourceUrl: leadEvidence.sourceUrl,
      evidenceType: leadEvidence.evidenceType,
      evidenceText: leadEvidence.evidenceText,
      metadata: leadEvidence.metadata,
      retrievedAt: leadEvidence.evidenceTimestamp,
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
}
