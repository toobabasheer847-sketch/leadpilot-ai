import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE } from '../database/database.constants';
import type { Database } from '../database/database.types';
import { auditLogs, companies, companyContacts, leadEvidence } from '../database/schema/schema';
import { ContactDiscoveryQueue } from './contact-discovery.queue';
import { PersonDiscoveryService } from './discovery/person-discovery.service';
import { ContactEvidenceService } from './verification/contact-evidence.service';
import { ContactDiscoveryContext } from './types/contact.types';
import { UsageService } from '../usage/usage.service';
import { ProviderObservabilityService } from '../common/observability/provider-observability.service';
import { pipelineJobs } from '../database/schema/schema';
import { createHash } from 'node:crypto';

@Injectable()
export class ContactsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly discovery: PersonDiscoveryService,
    private readonly evidenceService: ContactEvidenceService,
    private readonly queue: ContactDiscoveryQueue,
    private readonly usage: UsageService,
    private readonly providerObservability: ProviderObservabilityService,
  ) {}

  async enqueueContactDiscovery(companyId: string, organizationId: string, searchExecutionId?: string | null) {
    const [company] = await this.db.select().from(companies).where(and(
      eq(companies.id, companyId),
      eq(companies.organizationId, organizationId),
    )).limit(1);
    if (!company) throw new NotFoundException('Company not found');

    await this.usage.checkRequestRate(organizationId, undefined, 'CONTACT_DISCOVERY');
    const idempotencyKey = this.jobKey(companyId, organizationId, searchExecutionId ?? null);
    const [existingJob] = await this.db.select({ bullJobId: pipelineJobs.bullJobId }).from(pipelineJobs).where(eq(pipelineJobs.bullJobId, idempotencyKey)).limit(1);
    if (existingJob?.bullJobId) return { companyId, status: 'QUEUED', jobId: existingJob.bullJobId };
    const job = await this.queue.enqueue({ companyId, organizationId, searchExecutionId: searchExecutionId ?? null, idempotencyKey });
    await this.db.insert(pipelineJobs).values({ searchExecutionId: searchExecutionId ?? null, jobType: 'CONTACT_DISCOVERY', status: 'QUEUED', bullJobId: idempotencyKey });
    return { companyId, status: 'QUEUED', jobId: String(job.id) };
  }

  async discoverForCompany(companyId: string, organizationId: string, searchExecutionId?: string | null, correlationId?: string) {
    const [company] = await this.db.select().from(companies).where(and(
      eq(companies.id, companyId),
      eq(companies.organizationId, organizationId),
    )).limit(1);
    if (!company) throw new NotFoundException('Company not found');

    const context: ContactDiscoveryContext = { companyId, organizationId, searchExecutionId: searchExecutionId ?? null, companyWebsite: company.website ?? null, correlationId };
    await this.usage.checkRequestRate(organizationId, undefined, 'CONTACT_DISCOVERY');
    let result;
    try {
      result = await this.providerObservability.track('website', 'CONTACT_DISCOVERY', async () => ({ value: await this.discovery.discover({ id: company.id, name: company.name, website: company.website ?? null }, context) }));
    } catch (error) {
      await this.usage.recordUsage({ organizationId, operation: 'CONTACT_DISCOVERY', provider: 'website', resourceType: 'company', resourceId: companyId, units: 1, status: 'FAILED' });
      throw error;
    }
    await this.usage.recordUsage({ organizationId, operation: 'CONTACT_DISCOVERY', provider: 'website', resourceType: 'company', resourceId: companyId, units: Math.max(1, result.candidates.length), status: 'COMPLETED', metadata: { candidates: result.candidates.length } });

    let saved = 0;
    for (const candidate of result.candidates) {
      const [existing] = await this.db.select().from(companyContacts).where(and(
        eq(companyContacts.companyId, companyId),
        eq(companyContacts.fullName, candidate.fullName),
      )).limit(1);

      const [contact] = existing
        ? await this.db.update(companyContacts).set({
            ...(candidate.title && this.sameStoredValue(existing.title, candidate.title) ? { title: candidate.title } : {}),
            ...(candidate.normalizedRole && this.sameStoredValue(existing.normalizedRole, candidate.normalizedRole) ? { normalizedRole: candidate.normalizedRole } : {}),
            ...(candidate.companyRelationship && !existing.companyRelationship ? { companyRelationship: candidate.companyRelationship } : {}),
            ...(candidate.professionalBio && !existing.professionalBio ? { professionalBio: candidate.professionalBio } : {}),
            ...(candidate.email && this.sameStoredValue(existing.email, candidate.email) ? { email: candidate.email, emailStatus: candidate.emailStatus ?? existing.emailStatus } : {}),
            ...(candidate.phone && this.sameStoredValue(existing.phone, candidate.phone) ? { phone: candidate.phone, phoneStatus: candidate.phoneStatus ?? existing.phoneStatus } : {}),
            ...(candidate.linkedinUrl && !existing.linkedinUrl ? { linkedinUrl: candidate.linkedinUrl } : {}),
            ...(candidate.facebookUrl && !existing.facebookUrl ? { facebookUrl: candidate.facebookUrl } : {}),
            ...(candidate.instagramUrl && !existing.instagramUrl ? { instagramUrl: candidate.instagramUrl } : {}),
            ...(candidate.youtubeUrl && !existing.youtubeUrl ? { youtubeUrl: candidate.youtubeUrl } : {}),
            source: existing.source ?? candidate.sourceUrl,
            updatedAt: new Date(),
          }).where(eq(companyContacts.id, existing.id)).returning()
        : await this.db.insert(companyContacts).values({
            companyId,
            fullName: candidate.fullName,
            firstName: candidate.fullName.split(' ')[0] ?? candidate.fullName,
            lastName: candidate.fullName.split(' ').slice(1).join(' ') || null,
            title: candidate.title,
            normalizedRole: candidate.normalizedRole ?? null,
            companyRelationship: candidate.companyRelationship ?? null,
            professionalBio: candidate.professionalBio ?? null,
            email: candidate.email ?? null,
            emailStatus: candidate.emailStatus ?? (candidate.email ? 'FOUND' : 'NOT_FOUND'),
            phone: candidate.phone ?? null,
            phoneStatus: candidate.phoneStatus ?? (candidate.phone ? 'FOUND' : 'NOT_FOUND'),
            linkedinUrl: candidate.linkedinUrl ?? null,
            facebookUrl: candidate.facebookUrl ?? null,
            instagramUrl: candidate.instagramUrl ?? null,
            youtubeUrl: candidate.youtubeUrl ?? null,
            source: candidate.sourceUrl,
            status: 'DISCOVERED',
            confidence: '0.8000',
            verificationStatus: 'NOT_VERIFIED',
          }).returning();

      if (contact) {
        await this.evidenceService.persistEvidence(companyId, contact.id, organizationId, candidate);
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

  private jobKey(companyId: string, organizationId: string, searchExecutionId: string | null) {
    return `contact-discovery-${createHash('sha256').update(`${organizationId}:${companyId}:${searchExecutionId ?? 'direct'}`).digest('hex')}`;
  }

  private sameStoredValue(current: string | null, incoming: string | null) {
    if (!current) return Boolean(incoming);
    return current.trim().toLowerCase() === (incoming ?? '').trim().toLowerCase();
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
