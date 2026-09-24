import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE } from '../database/database.constants';
import type { Database } from '../database/database.types';
import { auditLogs, companies, companyContacts, leadEvidence } from '../database/schema/schema';
import { ContactDiscoveryQueue } from './contact-discovery.queue';
import { PersonDiscoveryService } from './discovery/person-discovery.service';
import { ContactEvidenceService } from './verification/contact-evidence.service';
import { ContactDiscoveryContext } from './types/contact.types';

@Injectable()
export class ContactsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly discovery: PersonDiscoveryService,
    private readonly evidenceService: ContactEvidenceService,
    private readonly queue: ContactDiscoveryQueue,
  ) {}

  async enqueueContactDiscovery(companyId: string, organizationId: string, searchExecutionId?: string | null) {
    const [company] = await this.db.select().from(companies).where(and(
      eq(companies.id, companyId),
      eq(companies.organizationId, organizationId),
    )).limit(1);
    if (!company) throw new NotFoundException('Company not found');

    await this.queue.enqueue({ companyId, organizationId, searchExecutionId: searchExecutionId ?? null });
    return { companyId, status: 'QUEUED' };
  }

  async discoverForCompany(companyId: string, organizationId: string, searchExecutionId?: string | null) {
    const [company] = await this.db.select().from(companies).where(and(
      eq(companies.id, companyId),
      eq(companies.organizationId, organizationId),
    )).limit(1);
    if (!company) throw new NotFoundException('Company not found');

    const context: ContactDiscoveryContext = { companyId, organizationId, searchExecutionId: searchExecutionId ?? null, companyWebsite: company.website ?? null };
    const result = await this.discovery.discover({ id: company.id, name: company.name, website: company.website ?? null }, context);

    let saved = 0;
    for (const candidate of result.candidates) {
      const [existing] = await this.db.select().from(companyContacts).where(and(
        eq(companyContacts.companyId, companyId),
        eq(companyContacts.fullName, candidate.fullName),
      )).limit(1);

      const [contact] = existing
        ? await this.db.update(companyContacts).set({
            title: candidate.title,
            email: candidate.email ?? null,
            phone: candidate.phone ?? null,
            linkedinUrl: candidate.linkedinUrl ?? null,
            facebookUrl: candidate.facebookUrl ?? null,
            instagramUrl: candidate.instagramUrl ?? null,
            source: candidate.sourceUrl,
            status: 'DISCOVERED',
            confidence: 0.8,
            verificationStatus: 'NOT_VERIFIED',
            updatedAt: new Date(),
          }).where(eq(companyContacts.id, existing.id)).returning()
        : await this.db.insert(companyContacts).values({
            companyId,
            fullName: candidate.fullName,
            firstName: candidate.fullName.split(' ')[0] ?? candidate.fullName,
            lastName: candidate.fullName.split(' ').slice(1).join(' ') || null,
            title: candidate.title,
            email: candidate.email ?? null,
            phone: candidate.phone ?? null,
            linkedinUrl: candidate.linkedinUrl ?? null,
            facebookUrl: candidate.facebookUrl ?? null,
            instagramUrl: candidate.instagramUrl ?? null,
            source: candidate.sourceUrl,
            status: 'DISCOVERED',
            confidence: 0.8,
            verificationStatus: 'NOT_VERIFIED',
          }).returning();

      if (contact) {
        await this.evidenceService.persistEvidence(companyId, contact.id, candidate);
        saved += 1;
      }
    }

    await this.db.insert(auditLogs).values({
      organizationId,
      entityId: companyId,
      action: 'CONTACT_DISCOVERY_COMPLETED',
      entityType: 'company',
      metadata: { companyId, candidates: String(saved) },
    });

    return { companyId, candidates: saved, status: 'COMPLETED' };
  }

  async listForCompany(companyId: string, organizationId: string) {
    const rows = await this.db.select({
      contact: companyContacts,
      company: companies,
    }).from(companyContacts)
      .innerJoin(companies, eq(companies.id, companyContacts.companyId))
      .where(and(
        eq(companyContacts.companyId, companyId),
        eq(companies.organizationId, organizationId),
      ));
    return rows.map((row) => ({ ...row.contact, company: row.company }));
  }

  async findById(contactId: string, organizationId: string) {
    const [contact] = await this.db.select({
      contact: companyContacts,
      company: companies,
    }).from(companyContacts)
      .innerJoin(companies, eq(companies.id, companyContacts.companyId))
      .where(and(
        eq(companyContacts.id, contactId),
        eq(companies.organizationId, organizationId),
      ))
      .limit(1);
    if (!contact) throw new NotFoundException('Contact not found');
    return {
      ...contact.contact,
      company: contact.company,
      evidence: await this.db.select().from(leadEvidence).where(eq(leadEvidence.contactId, contactId)),
    };
  }

  async listEvidence(contactId: string, organizationId: string) {
    const contact = await this.findById(contactId, organizationId);
    return contact.evidence;
  }
}
