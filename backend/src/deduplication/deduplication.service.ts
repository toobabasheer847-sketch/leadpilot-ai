import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, count, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { DRIZZLE } from '../database/database.constants';
import type { Database } from '../database/database.types';
import {
  auditLogs, companies, companyContacts, companyLocations, companySocialProfiles,
  duplicateGroups, leadDuplicates, leadEvidence, leadVerifications, searchExecutions, sourceRecords,
} from '../database/schema/schema';
import { DeduplicationQueue, type DeduplicationJobData } from './deduplication.queue';
import { electMaster, matchCompanies, matchContacts, orderedPair } from './matching/matching';
import { electCompanyMaster, mergeCompanyScalars, mergeContactScalars } from './merge/entity-merge';
import {
  companyFieldCompleteness, contactFieldCompleteness, normalizeCompany, normalizeContact, normalizeDomain,
} from './normalization/normalization';
import type { MatchDecision } from './types/deduplication.types';
import type { SearchPlan } from '../search/types/search-plan.types';

@Injectable()
export class DeduplicationService {
  constructor(@Inject(DRIZZLE) private readonly db: Database, private readonly queue: DeduplicationQueue) {}

  enqueueCompany(companyId: string, organizationId: string, searchExecutionId?: string | null) {
    return this.enqueue('COMPANY', companyId, organizationId, searchExecutionId ?? null);
  }

  enqueueContact(contactId: string, organizationId: string, searchExecutionId?: string | null) {
    return this.enqueue('CONTACT', contactId, organizationId, searchExecutionId ?? null);
  }

  async list(organizationId: string) {
    return this.db.select().from(leadDuplicates).where(eq(leadDuplicates.organizationId, organizationId)).orderBy(desc(leadDuplicates.createdAt));
  }

  async getDuplicate(id: string, organizationId: string) {
    const [duplicate] = await this.db.select().from(leadDuplicates).where(and(eq(leadDuplicates.id, id), eq(leadDuplicates.organizationId, organizationId))).limit(1);
    if (!duplicate) throw new NotFoundException('Duplicate decision not found');
    return duplicate;
  }

  async getGroup(id: string, organizationId: string) {
    const [group] = await this.db.select().from(duplicateGroups).where(and(eq(duplicateGroups.id, id), eq(duplicateGroups.organizationId, organizationId))).limit(1);
    if (!group) throw new NotFoundException('Duplicate group not found');
    const members = await this.db.select().from(leadDuplicates).where(and(eq(leadDuplicates.groupId, id), eq(leadDuplicates.organizationId, organizationId)));
    return { ...group, members };
  }

  async review(id: string, organizationId: string, reviewerId: string, decision: 'CONFIRMED_DUPLICATE' | 'NOT_DUPLICATE' | 'CONFLICT', reason?: string) {
    await this.getDuplicate(id, organizationId);
    const [updated] = await this.db.update(leadDuplicates).set({ status: decision, reviewedBy: reviewerId, reviewedAt: new Date(), reviewedReason: reason ?? null, updatedAt: new Date() }).where(and(eq(leadDuplicates.id, id), eq(leadDuplicates.organizationId, organizationId))).returning();
    await this.audit(organizationId, id, 'DUPLICATE_REVIEWED', { decision, reason: reason ?? null });
    return updated;
  }

  async mergeGroup(groupId: string, organizationId: string, canonicalEntityId?: string) {
    const group = await this.getGroup(groupId, organizationId);
    if (group.status === 'NOT_DUPLICATE' || group.status === 'CONFLICT') throw new Error('Duplicate group cannot be merged');
    const ids = [...new Set(group.members.flatMap((member) => [member.entityAId, member.entityBId]))];
    const masterId = canonicalEntityId && ids.includes(canonicalEntityId)
      ? canonicalEntityId
      : await this.electMasterForIds(group.entityType as 'COMPANY' | 'CONTACT', ids, organizationId);

    const updated = await this.db.transaction(async (tx) => {
      if (group.entityType === 'COMPANY') await this.mergeCompanies(tx, masterId, ids, organizationId);
      else await this.mergeContacts(tx, masterId, ids, organizationId);
      const [row] = await tx.update(duplicateGroups).set({ canonicalEntityId: masterId, status: 'MERGED', updatedAt: new Date() }).where(and(eq(duplicateGroups.id, groupId), eq(duplicateGroups.organizationId, organizationId))).returning();
      await tx.update(leadDuplicates).set({ status: 'CONFIRMED_DUPLICATE', updatedAt: new Date() }).where(and(eq(leadDuplicates.groupId, groupId), eq(leadDuplicates.organizationId, organizationId)));
      return row;
    });
    await this.audit(organizationId, groupId, 'DUPLICATE_GROUP_MERGED', { canonicalEntityId: masterId, entityType: group.entityType });
    return updated;
  }

  async rejectGroup(groupId: string, organizationId: string, reviewerId: string, reason?: string) {
    await this.getGroup(groupId, organizationId);
    const [updated] = await this.db.update(duplicateGroups).set({ status: 'NOT_DUPLICATE', reason: reason ?? null, updatedAt: new Date() }).where(and(eq(duplicateGroups.id, groupId), eq(duplicateGroups.organizationId, organizationId))).returning();
    await this.db.update(leadDuplicates).set({ status: 'NOT_DUPLICATE', reviewedBy: reviewerId, reviewedAt: new Date(), reviewedReason: reason ?? null, updatedAt: new Date() }).where(and(eq(leadDuplicates.groupId, groupId), eq(leadDuplicates.organizationId, organizationId)));
    await this.audit(organizationId, groupId, 'DUPLICATE_GROUP_REJECTED', { reason: reason ?? null });
    return updated;
  }

  deduplicateQueued(data: DeduplicationJobData) { return this.run(data); }

  private async enqueue(entityType: 'COMPANY' | 'CONTACT', entityId: string, organizationId: string, searchExecutionId: string | null) {
    if (entityType === 'COMPANY') await this.findCompany(entityId, organizationId);
    else await this.findContact(entityId, organizationId);
    const job = await this.queue.enqueue({ entityType, entityId, organizationId, searchExecutionId });
    await this.audit(organizationId, entityId, 'LEAD_DEDUPLICATION_STARTED', { entityType, jobId: job.id, searchExecutionId });
    return { status: 'QUEUED' as const, jobId: job.id };
  }

  private async run(data: DeduplicationJobData) {
    await this.loadPlan(data.searchExecutionId, data.organizationId);
    const decisions = data.entityType === 'COMPANY'
      ? await this.matchCompanyCandidates(data)
      : await this.matchContactCandidates(data);
    for (const decision of decisions) {
      await this.persistDecision(data.organizationId, decision);
      if (decision.autoMergeEligible && decision.status === 'AUTO_DUPLICATE') {
        await this.autoMergePair(data.organizationId, decision);
      }
    }
    await this.audit(data.organizationId, data.entityId, 'LEAD_DEDUPLICATION_COMPLETED', { entityType: data.entityType, matches: decisions.length });
    return decisions;
  }

  private async matchCompanyCandidates(data: DeduplicationJobData) {
    const company = await this.findCompany(data.entityId, data.organizationId);
    const normalized = await this.toNormalizedCompany(company, data.organizationId);
    const candidates = await this.findCompanyMatchCandidates(company, normalized, data.organizationId, data.searchExecutionId ?? null);
    const decisions: MatchDecision[] = [];
    for (const candidate of candidates) {
      if (candidate.id === company.id) continue;
      const other = await this.toNormalizedCompany(candidate, data.organizationId);
      decisions.push(matchCompanies(normalized, other));
    }
    return decisions;
  }

  private async matchContactCandidates(data: DeduplicationJobData) {
    const contact = await this.findContact(data.entityId, data.organizationId);
    const normalized = await this.toNormalizedContact(contact, data.organizationId);
    const candidates = await this.db.select({ contact: companyContacts })
      .from(companyContacts)
      .innerJoin(companies, eq(companies.id, companyContacts.companyId))
      .where(and(
        eq(companies.organizationId, data.organizationId),
        eq(companyContacts.companyId, contact.companyId),
        ne(companyContacts.id, contact.id),
      ));
    return Promise.all(candidates.map(async (row) => {
      const other = await this.toNormalizedContact(row.contact, data.organizationId);
      return matchContacts(normalized, other);
    }));
  }

  private async findCompanyMatchCandidates(
    company: typeof companies.$inferSelect,
    normalized: ReturnType<typeof normalizeCompany>,
    organizationId: string,
    searchExecutionId: string | null,
  ) {
    const conditions = [eq(companies.organizationId, organizationId), ne(companies.id, company.id)];
    if (searchExecutionId) {
      // Prefer companies that share source records in this execution when available.
      const linked = await this.db.select({ companyId: sourceRecords.companyId }).from(sourceRecords).where(and(
        eq(sourceRecords.organizationId, organizationId),
        eq(sourceRecords.searchExecutionId, searchExecutionId),
      ));
      const linkedIds = [...new Set(linked.map((row) => row.companyId).filter((id): id is string => Boolean(id)))];
      if (linkedIds.length) conditions.push(inArray(companies.id, linkedIds));
    }

    const byPlace = company.googlePlaceId
      ? await this.db.select().from(companies).where(and(...conditions, eq(companies.googlePlaceId, company.googlePlaceId)))
      : [];
    const byPhone = normalized.phone
      ? await this.db.select().from(companies).where(and(...conditions, eq(companies.phone, company.phone!)))
      : [];
    const byEmail = company.email
      ? await this.db.select().from(companies).where(and(...conditions, eq(companies.email, company.email)))
      : [];
    const byName = await this.db.select().from(companies).where(and(...conditions, sql`lower(${companies.name}) = ${company.name.toLowerCase()}`));

    let byExternal: Array<typeof companies.$inferSelect> = [];
    if (normalized.externalIds.length) {
      const rows = await this.db.select({ companyId: sourceRecords.companyId }).from(sourceRecords).where(and(
        eq(sourceRecords.organizationId, organizationId),
        inArray(sourceRecords.externalId, normalized.externalIds),
      ));
      const ids = [...new Set(rows.map((row) => row.companyId).filter((id): id is string => Boolean(id) && id !== company.id))];
      if (ids.length) byExternal = await this.db.select().from(companies).where(and(eq(companies.organizationId, organizationId), inArray(companies.id, ids)));
    }

    let byDomain: Array<typeof companies.$inferSelect> = [];
    if (normalized.domain) {
      const all = await this.db.select().from(companies).where(and(...conditions));
      byDomain = all.filter((row) => normalizeDomain(row.website) === normalized.domain);
    }

    const map = new Map<string, typeof companies.$inferSelect>();
    for (const row of [...byPlace, ...byPhone, ...byEmail, ...byName, ...byExternal, ...byDomain]) map.set(row.id, row);
    return [...map.values()];
  }

  private async toNormalizedCompany(company: typeof companies.$inferSelect, organizationId: string) {
    const [location] = await this.db.select().from(companyLocations).where(eq(companyLocations.companyId, company.id)).limit(1);
    const socials = await this.db.select({ url: companySocialProfiles.profileUrl }).from(companySocialProfiles).where(eq(companySocialProfiles.companyId, company.id));
    const sources = await this.db.select({ externalId: sourceRecords.externalId }).from(sourceRecords).where(and(eq(sourceRecords.companyId, company.id), eq(sourceRecords.organizationId, organizationId)));
    const evidence = await this.db.select({ total: count() }).from(leadEvidence).where(and(eq(leadEvidence.companyId, company.id)));
    const contacts = await this.db.select({ total: count() }).from(companyContacts).where(eq(companyContacts.companyId, company.id));
    const verifications = await this.db.select().from(leadVerifications).where(and(
      eq(leadVerifications.companyId, company.id),
      eq(leadVerifications.organizationId, organizationId),
    ));
    const emailVerified = verifications.some((row) => row.field === 'email' && (row.status === 'VERIFIED' || row.status === 'SUPPORTED'));
    const phoneVerified = verifications.some((row) => row.field === 'phone' && (row.status === 'VERIFIED' || row.status === 'SUPPORTED'));
    return normalizeCompany({
      ...company,
      address: location?.addressLine1,
      city: location?.city,
      state: location?.state,
      socialUrls: socials.map((item) => item.url),
      externalIds: [
        ...sources.map((row) => row.externalId).filter((id): id is string => Boolean(id)),
        ...(company.googlePlaceId ? [company.googlePlaceId] : []),
      ],
      emailVerified,
      phoneVerified,
      verificationStatus: company.verificationStatus,
      evidenceCount: Number(evidence[0]?.total ?? 0),
      contactCount: Number(contacts[0]?.total ?? 0),
      fieldCompleteness: companyFieldCompleteness(company),
    });
  }

  private async toNormalizedContact(contact: typeof companyContacts.$inferSelect, organizationId: string) {
    const verifications = await this.db.select().from(leadVerifications).where(and(
      eq(leadVerifications.contactId, contact.id),
      eq(leadVerifications.organizationId, organizationId),
    ));
    const evidence = await this.db.select({ total: count() }).from(leadEvidence).where(eq(leadEvidence.contactId, contact.id));
    return normalizeContact({
      ...contact,
      socialUrls: [contact.linkedinUrl, contact.facebookUrl, contact.instagramUrl, contact.youtubeUrl].filter((value): value is string => Boolean(value)),
      linkedinUrl: contact.linkedinUrl,
      emailVerified: verifications.some((row) => row.field === 'email' && (row.status === 'VERIFIED' || row.status === 'SUPPORTED')),
      phoneVerified: verifications.some((row) => row.field === 'phone' && (row.status === 'VERIFIED' || row.status === 'SUPPORTED')),
      verificationStatus: contact.verificationStatus,
      evidenceCount: Number(evidence[0]?.total ?? 0),
      fieldCompleteness: contactFieldCompleteness(contact),
    });
  }

  private async persistDecision(organizationId: string, decision: MatchDecision) {
    if (decision.matchType === 'NO_MATCH' || decision.status === 'PENDING') return null;
    const [entityAId, entityBId] = orderedPair(decision.recordA, decision.recordB);
    const [existing] = await this.db.select({ id: leadDuplicates.id }).from(leadDuplicates).where(and(
      eq(leadDuplicates.organizationId, organizationId),
      eq(leadDuplicates.entityType, decision.entityType),
      eq(leadDuplicates.entityAId, entityAId),
      eq(leadDuplicates.entityBId, entityBId),
    )).limit(1);
    if (existing) return existing;

    const [group] = await this.db.select().from(duplicateGroups).where(and(
      eq(duplicateGroups.organizationId, organizationId),
      eq(duplicateGroups.entityType, decision.entityType),
      or(eq(duplicateGroups.canonicalEntityId, entityAId), eq(duplicateGroups.canonicalEntityId, entityBId)),
    )).limit(1);
    const masterId = decision.entityType === 'COMPANY'
      ? await this.electMasterForIds('COMPANY', [entityAId, entityBId], organizationId)
      : await this.electMasterForIds('CONTACT', [entityAId, entityBId], organizationId);
    const groupId = group?.id ?? (await this.db.insert(duplicateGroups).values({
      organizationId,
      entityType: decision.entityType,
      canonicalEntityId: masterId,
      status: decision.status === 'AUTO_DUPLICATE' ? 'AUTO_DUPLICATE' : 'NEEDS_REVIEW',
      reason: decision.reason,
    }).returning())[0]?.id;

    const [stored] = await this.db.insert(leadDuplicates).values({
      organizationId,
      entityType: decision.entityType,
      entityAId,
      entityBId,
      groupId: groupId ?? null,
      companyId: decision.entityType === 'COMPANY' ? entityAId : null,
      duplicateCompanyId: decision.entityType === 'COMPANY' ? entityBId : null,
      matchType: decision.matchType,
      confidence: decision.confidence.toFixed(4),
      status: decision.status,
      signals: decision.signals,
      reason: decision.reason,
    }).onConflictDoNothing({ target: [leadDuplicates.organizationId, leadDuplicates.entityType, leadDuplicates.entityAId, leadDuplicates.entityBId] }).returning();
    return stored ?? existing;
  }

  private async autoMergePair(organizationId: string, decision: MatchDecision) {
    const ids = [decision.recordA, decision.recordB];
    const masterId = await this.electMasterForIds(decision.entityType, ids, organizationId);
    await this.db.transaction(async (tx) => {
      if (decision.entityType === 'COMPANY') await this.mergeCompanies(tx, masterId, ids, organizationId);
      else await this.mergeContacts(tx, masterId, ids, organizationId);
    });
    await this.audit(organizationId, masterId, 'LEAD_AUTO_MERGED', { entityType: decision.entityType, ids, masterId });
  }

  private async electMasterForIds(entityType: 'COMPANY' | 'CONTACT', ids: string[], organizationId: string) {
    if (entityType === 'COMPANY') {
      const rows = await this.db.select().from(companies).where(and(eq(companies.organizationId, organizationId), inArray(companies.id, ids)));
      const candidates = await Promise.all(rows.map(async (row) => {
        const evidence = await this.db.select({ total: count() }).from(leadEvidence).where(eq(leadEvidence.companyId, row.id));
        const contacts = await this.db.select({ total: count() }).from(companyContacts).where(eq(companyContacts.companyId, row.id));
        return {
          id: row.id,
          verificationStatus: row.verificationStatus,
          evidenceCount: Number(evidence[0]?.total ?? 0),
          contactCount: Number(contacts[0]?.total ?? 0),
          fieldCompleteness: companyFieldCompleteness(row),
        };
      }));
      return electCompanyMaster(candidates);
    }
    const rows = await this.db.select({ contact: companyContacts }).from(companyContacts)
      .innerJoin(companies, eq(companies.id, companyContacts.companyId))
      .where(and(eq(companies.organizationId, organizationId), inArray(companyContacts.id, ids)));
    const candidates = await Promise.all(rows.map(async (row) => {
      const evidence = await this.db.select({ total: count() }).from(leadEvidence).where(eq(leadEvidence.contactId, row.contact.id));
      return {
        id: row.contact.id,
        verificationStatus: row.contact.verificationStatus,
        evidenceCount: Number(evidence[0]?.total ?? 0),
        fieldCompleteness: contactFieldCompleteness(row.contact),
      };
    }));
    return electMaster(candidates);
  }

  private async mergeCompanies(tx: Database, masterId: string, ids: string[], organizationId: string) {
    const uniqueIds = [...new Set(ids)];
    if (!uniqueIds.includes(masterId)) throw new NotFoundException('Canonical company is not in duplicate group');
    const rows = await tx.select().from(companies).where(and(eq(companies.organizationId, organizationId), inArray(companies.id, uniqueIds)));
    if (rows.length !== uniqueIds.length) throw new NotFoundException('Company not found for organization');
    const master = rows.find((row) => row.id === masterId)!;
    const verified = await this.verifiedFields(organizationId, masterId, null);
    for (const loser of rows.filter((row) => row.id !== masterId)) {
      const updates = mergeCompanyScalars(master, loser, verified);
      if (Object.keys(updates).length) {
        await tx.update(companies).set({ ...updates, updatedAt: new Date() }).where(and(eq(companies.id, masterId), eq(companies.organizationId, organizationId)));
        Object.assign(master, updates);
      }
      await tx.update(companies).set({ canonicalCompanyId: masterId, updatedAt: new Date() }).where(and(eq(companies.id, loser.id), eq(companies.organizationId, organizationId)));
      await tx.update(sourceRecords).set({ companyId: masterId }).where(and(eq(sourceRecords.companyId, loser.id), eq(sourceRecords.organizationId, organizationId)));
      await tx.update(leadEvidence).set({ companyId: masterId }).where(eq(leadEvidence.companyId, loser.id));
      await tx.update(companyContacts).set({ companyId: masterId, updatedAt: new Date() }).where(eq(companyContacts.companyId, loser.id));
      const loserSocials = await tx.select().from(companySocialProfiles).where(eq(companySocialProfiles.companyId, loser.id));
      const masterSocials = await tx.select().from(companySocialProfiles).where(eq(companySocialProfiles.companyId, masterId));
      for (const social of loserSocials) {
        const duplicate = masterSocials.some((item) => item.platform === social.platform && item.profileUrl === social.profileUrl);
        if (duplicate) await tx.delete(companySocialProfiles).where(eq(companySocialProfiles.id, social.id));
        else await tx.update(companySocialProfiles).set({ companyId: masterId }).where(eq(companySocialProfiles.id, social.id));
      }
      await tx.update(companyLocations).set({ companyId: masterId }).where(eq(companyLocations.companyId, loser.id));
      await tx.update(leadVerifications).set({ companyId: masterId }).where(and(eq(leadVerifications.companyId, loser.id), eq(leadVerifications.organizationId, organizationId)));
    }
  }

  private async mergeContacts(tx: Database, masterId: string, ids: string[], organizationId: string) {
    const uniqueIds = [...new Set(ids)];
    if (!uniqueIds.includes(masterId)) throw new NotFoundException('Canonical contact is not in duplicate group');
    const rows = await tx.select({ contact: companyContacts, company: companies }).from(companyContacts)
      .innerJoin(companies, eq(companies.id, companyContacts.companyId))
      .where(and(eq(companies.organizationId, organizationId), inArray(companyContacts.id, uniqueIds)));
    if (rows.length !== uniqueIds.length) throw new NotFoundException('Contact not found for organization');
    const master = rows.find((row) => row.contact.id === masterId)!.contact;
    const verified = await this.verifiedFields(organizationId, master.companyId, masterId);
    for (const row of rows.filter((item) => item.contact.id !== masterId)) {
      const updates = mergeContactScalars(master, row.contact, verified);
      if (Object.keys(updates).length) {
        await tx.update(companyContacts).set({ ...updates, updatedAt: new Date() }).where(eq(companyContacts.id, masterId));
        Object.assign(master, updates);
      }
      await tx.update(companyContacts).set({ canonicalContactId: masterId, updatedAt: new Date() }).where(eq(companyContacts.id, row.contact.id));
      await tx.update(leadEvidence).set({ contactId: masterId }).where(eq(leadEvidence.contactId, row.contact.id));
      await tx.update(leadVerifications).set({ contactId: masterId }).where(and(eq(leadVerifications.contactId, row.contact.id), eq(leadVerifications.organizationId, organizationId)));
    }
  }

  private async verifiedFields(organizationId: string, companyId: string, contactId: string | null) {
    const rows = await this.db.select().from(leadVerifications).where(and(
      eq(leadVerifications.organizationId, organizationId),
      eq(leadVerifications.companyId, companyId),
      contactId ? eq(leadVerifications.contactId, contactId) : isNull(leadVerifications.contactId),
      inArray(leadVerifications.status, ['VERIFIED', 'SUPPORTED']),
    ));
    return new Set(rows.map((row) => row.field || row.fieldName).filter(Boolean) as string[]);
  }

  private async loadPlan(searchExecutionId: string | null | undefined, organizationId: string): Promise<SearchPlan | null> {
    if (!searchExecutionId) return null;
    const [row] = await this.db.select({ plan: searchExecutions.structuredPlan }).from(searchExecutions).where(and(
      eq(searchExecutions.id, searchExecutionId),
      eq(searchExecutions.organizationId, organizationId),
    )).limit(1);
    return row?.plan && typeof row.plan === 'object' ? row.plan as SearchPlan : null;
  }

  private async findCompany(id: string, organizationId: string) {
    const [row] = await this.db.select().from(companies).where(and(eq(companies.id, id), eq(companies.organizationId, organizationId))).limit(1);
    if (!row) throw new NotFoundException('Company not found');
    return row;
  }

  private async findContact(id: string, organizationId: string) {
    const [row] = await this.db.select({ contact: companyContacts }).from(companyContacts)
      .innerJoin(companies, eq(companies.id, companyContacts.companyId))
      .where(and(eq(companyContacts.id, id), eq(companies.organizationId, organizationId))).limit(1);
    if (!row) throw new NotFoundException('Contact not found');
    return row.contact;
  }

  private audit(organizationId: string, entityId: string, action: string, metadata: unknown) {
    return this.db.insert(auditLogs).values({ organizationId, entityId, action, entityType: 'deduplication', metadata });
  }
}
