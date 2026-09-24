import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE } from '../../database/database.constants';
import type { Database } from '../../database/database.types';
import { companies, companyContacts, leadDuplicates, leadEvidence, leadVerifications, verificationConflicts } from '../../database/schema/schema';
import { ScoringService } from '../../scoring/scoring.service';
import { StructuredLoggerService } from '../../common/observability/structured-logger.service';
import { ContactQualityJobData, ContactQualityQueue } from './contact-quality.queue';
import { ContactFieldStatus, ContactQualityEvidence, ContactQualityResult, contactAccessAllowed, evaluateContactQuality } from './contact-quality.engine';

const FIELD_COLUMNS = {
  name: 'fullName',
  title: 'title',
  email: 'email',
  phone: 'phone',
  linkedin: 'linkedin',
  facebook: 'facebook',
  instagram: 'instagram',
  youtube: 'youtube',
} as const;

@Injectable()
export class ContactQualityService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly config: ConfigService,
    private readonly queue: ContactQualityQueue,
    private readonly scoring: ScoringService,
    private readonly logger: StructuredLoggerService,
  ) {}

  async enqueue(companyId: string, contactId: string, organizationId: string) {
    await this.loadOwnedContact(companyId, contactId, organizationId);
    const jobId = `contact-quality-${createHash('sha256').update(`${organizationId}-${companyId}-${contactId}`).digest('hex')}`;
    const job = await this.queue.enqueue({ organizationId, companyId, contactId }, jobId);
    this.logger.info('job.contact_quality.queued', { jobId: job.id, organizationId, companyId, contactId });
    return { status: 'QUEUED' as const, jobId: job.id ?? jobId };
  }

  async verifyQueued(data: ContactQualityJobData) {
    const loaded = await this.loadOwnedContact(data.companyId, data.contactId, data.organizationId);
    const evidenceRows = await this.db.select().from(leadEvidence).where(eq(leadEvidence.contactId, loaded.contact.id));
    const peers = await this.db.select({
      id: companyContacts.id,
      fullName: companyContacts.fullName,
      email: companyContacts.email,
      phone: companyContacts.phone,
      linkedinUrl: companyContacts.linkedinUrl,
      title: companyContacts.title,
    }).from(companyContacts).where(eq(companyContacts.companyId, loaded.company.id));
    const result = evaluateContactQuality({
      contact: {
        id: loaded.contact.id,
        fullName: loaded.contact.fullName ?? '',
        title: loaded.contact.title,
        email: loaded.contact.email,
        phone: loaded.contact.phone,
        linkedinUrl: loaded.contact.linkedinUrl,
        facebookUrl: loaded.contact.facebookUrl,
        instagramUrl: loaded.contact.instagramUrl,
        youtubeUrl: loaded.contact.youtubeUrl,
        companyRelationship: loaded.contact.companyRelationship,
        createdAt: loaded.contact.createdAt.toISOString(),
      },
      company: { id: loaded.company.id, name: loaded.company.name, website: loaded.company.website, phone: loaded.company.phone },
      evidence: evidenceRows.map((row) => this.toEvidence(row)),
      peers: peers.map((peer) => ({ ...peer, fullName: peer.fullName ?? '' })),
      targetRoles: this.config.get<string[]>('decisionMaker.rolePriorities') ?? [],
      reverifyAfterDays: this.config.get<number>('verification.reVerifyAfterDays') ?? 30,
    });
    await this.persist(loaded.company.id, loaded.contact.id, data.organizationId, result);
    await this.scoring.scoreQueued({
      companyId: loaded.company.id,
      contactId: loaded.contact.id,
      organizationId: data.organizationId,
      searchExecutionId: null,
      force: true,
      idempotencyKey: createHash('sha256').update(`contact-quality-score-${data.organizationId}-${loaded.contact.id}-${result.lastVerifiedAt}`).digest('hex'),
    });
    return { contactId: loaded.contact.id, identityStatus: result.identityStatus, duplicateStatus: result.duplicateStatus };
  }

  async list(companyId: string, organizationId: string) {
    const rows = await this.db.select({ contact: companyContacts, company: companies }).from(companyContacts)
      .innerJoin(companies, eq(companies.id, companyContacts.companyId))
      .where(and(eq(companyContacts.companyId, companyId), eq(companies.organizationId, organizationId)));
    if (!rows.length) {
      const [company] = await this.db.select({ id: companies.id }).from(companies).where(and(eq(companies.id, companyId), eq(companies.organizationId, organizationId))).limit(1);
      if (!company) throw new NotFoundException('Contact not found');
    }
    return rows.map((row) => this.present(row.contact, row.company));
  }

  async detail(companyId: string, contactId: string, organizationId: string) {
    const loaded = await this.loadOwnedContact(companyId, contactId, organizationId);
    const evidence = await this.db.select().from(leadEvidence).where(eq(leadEvidence.contactId, contactId));
    const conflicts = await this.db.select().from(verificationConflicts).where(and(eq(verificationConflicts.contactId, contactId), eq(verificationConflicts.organizationId, organizationId)));
    return { ...this.present(loaded.contact, loaded.company), evidence, conflicts };
  }

  private async persist(companyId: string, contactId: string, organizationId: string, result: ContactQualityResult) {
    for (const [field, assessment] of Object.entries(result.fields) as Array<[keyof typeof FIELD_COLUMNS, ContactQualityResult['fields']['name']]>) {
      await this.persistField(companyId, contactId, organizationId, FIELD_COLUMNS[field], assessment);
    }
    for (const conflict of result.conflicts) {
      const idempotencyKey = createHash('sha256').update(JSON.stringify({ organizationId, contactId, field: conflict.fieldName, valueA: conflict.valueA, valueB: conflict.valueB })).digest('hex');
      await this.db.insert(verificationConflicts).values({
        organizationId,
        companyId,
        contactId,
        fieldName: conflict.fieldName,
        valueA: conflict.valueA,
        valueB: conflict.valueB,
        sourceTypeA: conflict.sourceTypeA,
        sourceUrlA: conflict.sourceUrlA,
        retrievedAtA: new Date(conflict.retrievedAtA),
        evidenceExcerptA: conflict.evidenceExcerptA,
        sourceTypeB: conflict.sourceTypeB,
        sourceUrlB: conflict.sourceUrlB,
        retrievedAtB: new Date(conflict.retrievedAtB),
        evidenceExcerptB: conflict.evidenceExcerptB,
        status: 'CONFLICT',
        requiresReview: true,
        resolutionStatus: 'OPEN',
        idempotencyKey,
      }).onConflictDoUpdate({
        target: [verificationConflicts.organizationId, verificationConflicts.idempotencyKey],
        set: { status: 'CONFLICT', requiresReview: true, resolutionStatus: 'OPEN', evidenceExcerptA: conflict.evidenceExcerptA, evidenceExcerptB: conflict.evidenceExcerptB, updatedAt: new Date() },
      });
    }
    if (result.duplicateStatus === 'NEEDS_REVIEW' && result.duplicateContactId) {
      const [entityAId, entityBId] = [contactId, result.duplicateContactId].sort();
      await this.db.insert(leadDuplicates).values({
        organizationId,
        entityType: 'CONTACT',
        entityAId,
        entityBId,
        companyId,
        matchType: 'POSSIBLE_MATCH',
        confidence: '0.5000',
        status: 'REVIEW_REQUIRED',
        signals: [{ type: 'contact-quality', matched: true, weight: 0 }],
        reason: 'Possible duplicate contact requires review and was not merged.',
      }).onConflictDoNothing({ target: [leadDuplicates.organizationId, leadDuplicates.entityType, leadDuplicates.entityAId, leadDuplicates.entityBId] });
    }
    await this.db.update(companyContacts).set({
      emailStatus: result.fields.email.status,
      phoneStatus: result.fields.phone.status,
      verificationStatus: result.identityStatus,
      identityConfidence: this.confidence(result.identityStatus),
      identityEvidence: { ...result, autoMerged: false },
      lastVerifiedAt: new Date(result.lastVerifiedAt),
      ...(result.role.status !== 'CONFLICT' && result.role.matchedRole ? { normalizedRole: result.role.matchedRole } : {}),
      updatedAt: new Date(),
    }).where(eq(companyContacts.id, contactId));
  }

  private async persistField(companyId: string, contactId: string, organizationId: string, field: string, assessment: ContactQualityResult['fields']['name']) {
    const supported = assessment.status === 'VERIFIED' || assessment.status === 'SUPPORTED';
    const patch = {
      fieldValue: assessment.value,
      verificationStatus: assessment.status,
      status: assessment.status,
      notes: assessment.reason,
      evidenceId: assessment.evidenceIds[0] ?? null,
      verifiedAt: supported ? new Date() : null,
      checkedAt: new Date(),
      metadata: { phoneKind: assessment.phoneKind ?? null, ownershipVerified: assessment.ownershipVerified ?? null, independentSources: assessment.independentSources, quality: true },
      updatedAt: new Date(),
    };
    await this.db.update(leadVerifications).set(patch).where(and(eq(leadVerifications.organizationId, organizationId), eq(leadVerifications.contactId, contactId), eq(leadVerifications.field, field)));
    const idempotencyKey = `contact-quality-${createHash('sha256').update(`${organizationId}-${contactId}-${field}`).digest('hex')}`;
    await this.db.insert(leadVerifications).values({
      companyId,
      contactId,
      organizationId,
      field,
      fieldName: field,
      verificationType: 'SOURCE_EVIDENCE',
      provider: 'contact-quality',
      idempotencyKey,
      ...patch,
    }).onConflictDoUpdate({
      target: [leadVerifications.organizationId, leadVerifications.idempotencyKey],
      set: patch,
    });
  }

  private present(contact: typeof companyContacts.$inferSelect, company: typeof companies.$inferSelect) {
    const quality = this.readQuality(contact.identityEvidence);
    const social = (platform: 'linkedin' | 'facebook' | 'instagram' | 'youtube', url: string | null) => quality?.fields[platform].status ?? (url ? 'UNVERIFIED' : 'NOT_FOUND');
    return {
      ...contact,
      company,
      name: contact.fullName,
      verificationStatus: quality?.identityStatus ?? contact.verificationStatus,
      emailStatus: quality?.fields.email.status ?? contact.emailStatus,
      phoneStatus: quality?.fields.phone.status ?? contact.phoneStatus,
      socialProfileStatus: {
        linkedin: social('linkedin', contact.linkedinUrl),
        facebook: social('facebook', contact.facebookUrl),
        instagram: social('instagram', contact.instagramUrl),
        youtube: social('youtube', contact.youtubeUrl),
      },
      evidenceSummary: {
        independentSources: quality?.independentSources ?? 0,
        conflictCount: quality?.conflicts.length ?? 0,
      },
      lastVerifiedAt: contact.lastVerifiedAt,
      discoveredAt: contact.createdAt,
      quality,
    };
  }

  private readQuality(value: unknown): ContactQualityResult | null {
    if (!value || typeof value !== 'object' || !('fields' in value)) return null;
    return value as ContactQualityResult;
  }

  private toEvidence(row: typeof leadEvidence.$inferSelect): ContactQualityEvidence {
    const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata as Record<string, unknown> : {};
    return {
      id: row.id,
      field: typeof metadata.field === 'string' ? metadata.field : row.evidenceType,
      value: typeof metadata.value === 'string' ? metadata.value : '',
      sourceType: row.sourceType,
      sourceUrl: row.sourceUrl,
      excerpt: typeof metadata.evidenceExcerpt === 'string' ? metadata.evidenceExcerpt : row.evidenceText,
      retrievedAt: (row.evidenceTimestamp ?? row.createdAt).toISOString(),
    };
  }

  private async loadOwnedContact(companyId: string, contactId: string, organizationId: string) {
    const [row] = await this.db.select({ contact: companyContacts, company: companies }).from(companyContacts)
      .innerJoin(companies, eq(companies.id, companyContacts.companyId))
      .where(and(eq(companyContacts.id, contactId), eq(companyContacts.companyId, companyId), eq(companies.organizationId, organizationId)))
      .limit(1);
    if (!row || !contactAccessAllowed(row.company.organizationId, organizationId)) throw new NotFoundException('Contact not found');
    return row;
  }

  private confidence(status: ContactFieldStatus) {
    if (status === 'VERIFIED') return '0.9000';
    if (status === 'SUPPORTED') return '0.6000';
    if (status === 'CONFLICT') return '0.3000';
    if (status === 'UNVERIFIED') return '0.2000';
    return '0.0000';
  }
}
