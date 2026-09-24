import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, ilike, inArray, or } from 'drizzle-orm';
import { DRIZZLE } from '../database/database.constants';
import type { Database } from '../database/database.types';
import { auditLogs, companies, companyContacts, companyLocations, companySocialProfiles, duplicateGroups, leadDuplicates } from '../database/schema/schema';
import { DeduplicationQueue, type DeduplicationJobData } from './deduplication.queue';
import { matchCompanies, matchContacts } from './matching/matching';
import { normalizeCompany, normalizeContact } from './normalization/normalization';
import type { MatchDecision } from './types/deduplication.types';

@Injectable()
export class DeduplicationService {
  constructor(@Inject(DRIZZLE) private readonly db: Database, private readonly queue: DeduplicationQueue) {}

  enqueueCompany(companyId: string, organizationId: string) { return this.enqueue('COMPANY', companyId, organizationId); }
  enqueueContact(contactId: string, organizationId: string) { return this.enqueue('CONTACT', contactId, organizationId); }

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

  async mergeGroup(groupId: string, organizationId: string, canonicalEntityId: string) {
    const group = await this.getGroup(groupId, organizationId);
    if (group.status === 'NOT_DUPLICATE' || group.status === 'CONFLICT') throw new Error('Duplicate group cannot be merged');
    if (group.entityType === 'CONTACT') {
      const ids = [...new Set(group.members.flatMap((member) => [member.entityAId, member.entityBId]))];
      if (!ids.includes(canonicalEntityId)) throw new NotFoundException('Canonical contact is not in duplicate group');
      for (const id of ids) await this.findContact(id, organizationId);
    }
    const updated = await this.db.transaction(async (tx) => {
      if (group.entityType === 'COMPANY') await this.mergeCompanyGroup(tx, group, canonicalEntityId, organizationId);
      else await this.mergeContactGroup(tx, group, canonicalEntityId);
      const [row] = await tx.update(duplicateGroups).set({ canonicalEntityId, status: 'MERGED', updatedAt: new Date() }).where(and(eq(duplicateGroups.id, groupId), eq(duplicateGroups.organizationId, organizationId))).returning();
      return row;
    });
    await this.audit(organizationId, groupId, 'DUPLICATE_GROUP_MERGED', { canonicalEntityId, entityType: group.entityType });
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

  private async enqueue(entityType: 'COMPANY' | 'CONTACT', entityId: string, organizationId: string) {
    if (entityType === 'COMPANY') await this.findCompany(entityId, organizationId);
    else await this.findContact(entityId, organizationId);
    const job = await this.queue.enqueue({ entityType, entityId, organizationId });
    await this.audit(organizationId, entityId, 'LEAD_DEDUPLICATION_STARTED', { entityType, jobId: job.id });
    return { status: 'QUEUED' as const, jobId: job.id };
  }

  private async run(data: DeduplicationJobData) {
    const decisions = data.entityType === 'COMPANY' ? await this.matchCompanyCandidates(data) : await this.matchContactCandidates(data);
    for (const decision of decisions) await this.persistDecision(data.organizationId, decision);
    await this.audit(data.organizationId, data.entityId, 'LEAD_DEDUPLICATION_COMPLETED', { entityType: data.entityType, matches: decisions.length });
    return decisions;
  }

  private async matchCompanyCandidates(data: DeduplicationJobData) {
    const company = await this.findCompany(data.entityId, data.organizationId);
    const [location] = await this.db.select().from(companyLocations).where(eq(companyLocations.companyId, company.id)).limit(1);
    const socials = await this.db.select({ url: companySocialProfiles.profileUrl }).from(companySocialProfiles).where(eq(companySocialProfiles.companyId, company.id));
    const normalized = normalizeCompany({ ...company, address: location?.addressLine1, city: location?.city, state: location?.state, socialUrls: socials.map((item) => item.url) });
    const candidates = await this.db.select().from(companies).where(and(eq(companies.organizationId, data.organizationId), or(company.website ? eq(companies.website, company.website) : ilike(companies.name, company.name), company.phone ? eq(companies.phone, company.phone) : ilike(companies.name, company.name), company.googlePlaceId ? eq(companies.googlePlaceId, company.googlePlaceId) : ilike(companies.name, company.name), ilike(companies.name, company.name))));
    const decisions: MatchDecision[] = [];
    for (const candidate of candidates.filter((item) => item.id !== company.id)) {
      const candidateLocation = await this.db.select().from(companyLocations).where(eq(companyLocations.companyId, candidate.id)).limit(1);
      const candidateSocials = await this.db.select({ url: companySocialProfiles.profileUrl }).from(companySocialProfiles).where(eq(companySocialProfiles.companyId, candidate.id));
      decisions.push(matchCompanies(normalized, normalizeCompany({ ...candidate, address: candidateLocation[0]?.addressLine1, city: candidateLocation[0]?.city, state: candidateLocation[0]?.state, socialUrls: candidateSocials.map((item) => item.url) })));
    }
    return decisions;
  }

  private async matchContactCandidates(data: DeduplicationJobData) {
    const contact = await this.findContact(data.entityId, data.organizationId);
    const normalized = normalizeContact({ ...contact, socialUrls: [contact.linkedinUrl, contact.facebookUrl, contact.instagramUrl].filter((value): value is string => Boolean(value)) });
    const candidates = await this.db.select().from(companyContacts).innerJoin(companies, eq(companies.id, companyContacts.companyId)).where(and(eq(companies.organizationId, data.organizationId), or(contact.email ? eq(companyContacts.email, contact.email) : ilike(companyContacts.fullName, contact.fullName ?? ''), contact.phone ? eq(companyContacts.phone, contact.phone) : ilike(companyContacts.fullName, contact.fullName ?? ''), eq(companyContacts.companyId, contact.companyId))));
    return candidates.filter((row) => row.company_contacts.id !== contact.id).map((row) => matchContacts(normalized, normalizeContact({ ...row.company_contacts, socialUrls: [row.company_contacts.linkedinUrl, row.company_contacts.facebookUrl, row.company_contacts.instagramUrl].filter((value): value is string => Boolean(value)) })));
  }

  private async persistDecision(organizationId: string, decision: MatchDecision) {
    if (decision.matchType === 'NO_MATCH') return;
    const [existing] = await this.db.select({ id: leadDuplicates.id }).from(leadDuplicates).where(and(eq(leadDuplicates.organizationId, organizationId), eq(leadDuplicates.entityType, decision.entityType), eq(leadDuplicates.entityAId, decision.recordA), eq(leadDuplicates.entityBId, decision.recordB))).limit(1);
    if (existing) return existing;
    const [group] = await this.db.select().from(duplicateGroups).where(and(eq(duplicateGroups.organizationId, organizationId), eq(duplicateGroups.entityType, decision.entityType), or(eq(duplicateGroups.canonicalEntityId, decision.recordA), eq(duplicateGroups.canonicalEntityId, decision.recordB)))).limit(1);
    const groupId = group?.id ?? (await this.db.insert(duplicateGroups).values({ organizationId, entityType: decision.entityType, canonicalEntityId: decision.recordA, status: decision.status, reason: decision.reason }).returning())[0]?.id;
    const [stored] = await this.db.insert(leadDuplicates).values({ organizationId, entityType: decision.entityType, entityAId: decision.recordA, entityBId: decision.recordB, groupId: groupId ?? null, companyId: decision.entityType === 'COMPANY' ? decision.recordA : null, duplicateCompanyId: decision.entityType === 'COMPANY' ? decision.recordB : null, matchType: decision.matchType, confidence: decision.confidence.toFixed(4), status: decision.status, signals: decision.signals, reason: decision.reason }).returning();
    return stored;
  }

  private async mergeCompanyGroup(db: Pick<Database, 'update'>, group: { members: Array<{ entityAId: string; entityBId: string }>; canonicalEntityId: string }, canonicalEntityId: string, organizationId: string) {
    const ids = [...new Set(group.members.flatMap((member) => [member.entityAId, member.entityBId]))];
    if (!ids.includes(canonicalEntityId)) throw new NotFoundException('Canonical company is not in duplicate group');
    await db.update(companies).set({ canonicalCompanyId: canonicalEntityId, updatedAt: new Date() }).where(and(inArray(companies.id, ids), eq(companies.organizationId, organizationId)));
  }

  private async mergeContactGroup(db: Pick<Database, 'update'>, group: { members: Array<{ entityAId: string; entityBId: string }>; canonicalEntityId: string }, canonicalEntityId: string) {
    const ids = [...new Set(group.members.flatMap((member) => [member.entityAId, member.entityBId]))];
    if (!ids.includes(canonicalEntityId)) throw new NotFoundException('Canonical contact is not in duplicate group');
    await db.update(companyContacts).set({ canonicalContactId: canonicalEntityId, updatedAt: new Date() }).where(inArray(companyContacts.id, ids));
  }

  private async findCompany(id: string, organizationId: string) { const [row] = await this.db.select().from(companies).where(and(eq(companies.id, id), eq(companies.organizationId, organizationId))).limit(1); if (!row) throw new NotFoundException('Company not found'); return row; }
  private async findContact(id: string, organizationId: string) { const [row] = await this.db.select({ contact: companyContacts }).from(companyContacts).innerJoin(companies, eq(companies.id, companyContacts.companyId)).where(and(eq(companyContacts.id, id), eq(companies.organizationId, organizationId))).limit(1); if (!row) throw new NotFoundException('Contact not found'); return row.contact; }
  private audit(organizationId: string, entityId: string, action: string, metadata: unknown) { return this.db.insert(auditLogs).values({ organizationId, entityId, action, entityType: 'deduplication', metadata }); }
}
