import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE } from '../database/database.constants';
import type { Database } from '../database/database.types';
import { auditLogs, companies, pipelineJobs, sourceRecords } from '../database/schema/schema';
import { CompanyEnrichmentRepository } from './repositories/company-enrichment.repository';
import { EvidenceRepository } from './repositories/evidence.repository';
import { CompanySocialDiscoveryService } from './social/company-social-discovery.service';
import { CompanyEnrichmentQueue } from './company-enrichment.queue';
import { WebsiteDiscoveryService } from './website/website-discovery.service';
import { WebsiteParserService } from './website/website-parser.service';
import { CompanyEnrichmentJobData, EnrichmentStatus } from './website/website.types';

@Injectable()
export class EnrichmentService {
  private readonly logger = new Logger(EnrichmentService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly queue: CompanyEnrichmentQueue,
    private readonly discovery: WebsiteDiscoveryService,
    private readonly parser: WebsiteParserService,
    private readonly socialDiscovery: CompanySocialDiscoveryService,
    private readonly companyRepository: CompanyEnrichmentRepository,
    private readonly evidenceRepository: EvidenceRepository,
  ) {}

  async enqueueCompanyEnrichment(executionId: string, organizationId: string): Promise<Array<{ companyId: string; status: 'QUEUED' }>> {
    const rows = await this.db.select({ companyId: sourceRecords.companyId }).from(sourceRecords)
      .where(and(eq(sourceRecords.searchExecutionId, executionId), eq(sourceRecords.organizationId, organizationId)))
      .groupBy(sourceRecords.companyId);

    const enqueued: Array<{ companyId: string; status: 'QUEUED' }> = [];
    for (const row of rows) {
      if (!row.companyId) {
        continue;
      }
      const company = await this.companyRepository.findCompanyForOrganization(row.companyId, organizationId);
      if (!company) {
        continue;
      }
      await this.db.insert(pipelineJobs).values({
        searchExecutionId: executionId,
        jobType: 'COMPANY_ENRICHMENT',
        status: 'QUEUED',
      });
      await this.queue.enqueue({ companyId: company.id, organizationId, searchExecutionId: executionId });
      enqueued.push({ companyId: company.id, status: 'QUEUED' });
    }
    return enqueued;
  }

  async enqueueForCompany(companyId: string, organizationId: string, searchExecutionId?: string | null): Promise<{ companyId: string; status: 'QUEUED' }> {
    const company = await this.companyRepository.findCompanyForOrganization(companyId, organizationId);
    if (!company) {
      throw new NotFoundException('Company not found');
    }

    await this.db.insert(pipelineJobs).values({
      searchExecutionId: searchExecutionId ?? null,
      jobType: 'COMPANY_ENRICHMENT',
      status: 'QUEUED',
    });

    await this.queue.enqueue({ companyId: company.id, organizationId, searchExecutionId: searchExecutionId ?? null });
    return { companyId: company.id, status: 'QUEUED' };
  }

  async runCompanyEnrichment(data: CompanyEnrichmentJobData) {
    const { companyId, organizationId } = data;
    const company = await this.companyRepository.findCompanyForOrganization(companyId, organizationId);
    if (!company) {
      throw new NotFoundException('Company not found');
    }

    const websiteResult = await this.discovery.discover(company.website ?? null, company.name);
    const updates: Record<string, string | null> = {};
    if (websiteResult.website) {
      updates.website = websiteResult.website;
    }

    let parsed = null;
    let discoveredSocial: string[] = [];

    if (websiteResult.page) {
      parsed = this.parser.parsePage(websiteResult.page.finalUrl, websiteResult.page.content);
      discoveredSocial = this.socialDiscovery.discover(websiteResult.page.content, websiteResult.page.finalUrl);

      if (parsed.companyName) {
        updates.name = parsed.companyName;
      }
      if (parsed.description) {
        updates.description = parsed.description;
      }
      if (parsed.phone) {
        updates.phone = parsed.phone;
      }
      if (parsed.publicEmail) {
        updates.email = parsed.publicEmail;
      }
      if (parsed.investmentStrategy) {
        updates.investmentStrategy = parsed.investmentStrategy;
      }
      if (parsed.address) {
        updates.name = company.name ?? parsed.companyName ?? company.name;
      }
      await this.evidenceRepository.persistEvidence(company.id, websiteResult.page.finalUrl, parsed.evidence);

      for (const socialUrl of discoveredSocial) {
        const host = new URL(socialUrl).hostname.toLowerCase();
        const platform = host.includes('linkedin') ? 'linkedin' : host.includes('facebook') ? 'facebook' : host.includes('instagram') ? 'instagram' : host.includes('youtube') ? 'youtube' : host.includes('x.com') || host.includes('twitter') ? 'x' : 'other';
        if (platform !== 'other') {
          await this.companyRepository.upsertSocialProfile(company.id, platform, socialUrl, null);
        }
      }
    }

    await this.companyRepository.updateCompany(company.id, updates);
    await this.db.insert(auditLogs).values({
      organizationId,
      entityId: company.id,
      action: 'COMPANY_ENRICHMENT_COMPLETED',
      entityType: 'company',
      metadata: { companyId: company.id, website: updates.website ?? null },
    });

    return {
      companyId: company.id,
      organizationId,
      website: updates.website ?? null,
      socialProfiles: discoveredSocial,
      fieldsExtracted: parsed ? Object.keys(parsed).length : 0,
    };
  }

  async getCompany(companyId: string, organizationId: string) {
    const company = await this.companyRepository.findCompanyForOrganization(companyId, organizationId);
    if (!company) {
      throw new NotFoundException('Company not found');
    }
    const socialProfiles = await this.companyRepository.getSocialProfiles(companyId, organizationId);
    const evidence = await this.evidenceRepository.listEvidenceForCompany(companyId, organizationId);
    const status = this.calculateEnrichmentStatus(company, socialProfiles.length, evidence.length);
    return {
      ...company,
      enrichmentStatus: status,
      socialProfiles: this.toSocialProfileMap(socialProfiles),
      evidenceCount: evidence.length,
    };
  }

  async getEvidence(companyId: string, organizationId: string) {
    const company = await this.companyRepository.findCompanyForOrganization(companyId, organizationId);
    if (!company) {
      throw new NotFoundException('Company not found');
    }
    return this.evidenceRepository.listEvidenceForCompany(companyId, organizationId);
  }

  async getSocialProfiles(companyId: string, organizationId: string) {
    const company = await this.companyRepository.findCompanyForOrganization(companyId, organizationId);
    if (!company) {
      throw new NotFoundException('Company not found');
    }
    const socialProfiles = await this.companyRepository.getSocialProfiles(companyId, organizationId);
    return this.toSocialProfileMap(socialProfiles);
  }

  private calculateEnrichmentStatus(company: typeof companies.$inferSelect, socialCount: number, evidenceCount: number): EnrichmentStatus {
    const hasWebsite = Boolean(company.website);
    const hasDescription = Boolean(company.description);
    const hasContact = Boolean(company.email || company.phone);
    if (hasWebsite && (hasDescription || hasContact || socialCount > 0 || evidenceCount > 0)) {
      return 'COMPLETED';
    }
    if (hasWebsite && !hasDescription && !hasContact && socialCount === 0 && evidenceCount === 0) {
      return 'PARTIAL';
    }
    if (!hasWebsite && (socialCount > 0 || hasDescription || hasContact || evidenceCount > 0)) {
      return 'PARTIAL';
    }
    return 'PENDING';
  }

  private toSocialProfileMap(socialProfiles: Array<{ platform: string; profileUrl: string; username: string | null }>) {
    const map: Record<string, string | null> = {
      linkedin: null,
      facebook: null,
      instagram: null,
      youtube: null,
      x: null,
      twitter: null,
    };

    for (const item of socialProfiles) {
      const normalized = item.platform.toLowerCase();
      if (normalized in map) {
        map[normalized] = item.profileUrl;
      }
    }
    return map;
  }
}
