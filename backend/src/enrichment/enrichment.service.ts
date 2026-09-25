import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE } from '../database/database.constants';
import type { Database } from '../database/database.types';
import { auditLogs, companies, pipelineJobs, sourceRecords } from '../database/schema/schema';
import { CompanyEnrichmentRepository } from './repositories/company-enrichment.repository';
import { EvidenceRepository } from './repositories/evidence.repository';
import { CompanySocialDiscoveryService } from './social/company-social-discovery.service';
import { CompanyEnrichmentQueue } from './company-enrichment.queue';
import { WebsiteDiscoveryService, websitesFromSourceRaw } from './website/website-discovery.service';
import { WebsiteParserService } from './website/website-parser.service';
import { CompanyEnrichmentJobData, EnrichmentStatus } from './website/website.types';
import { UsageService } from '../usage/usage.service';
import { ProviderObservabilityService } from '../common/observability/provider-observability.service';
import { createHash } from 'node:crypto';

@Injectable()
export class EnrichmentService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly queue: CompanyEnrichmentQueue,
    private readonly discovery: WebsiteDiscoveryService,
    private readonly parser: WebsiteParserService,
    private readonly socialDiscovery: CompanySocialDiscoveryService,
    private readonly companyRepository: CompanyEnrichmentRepository,
    private readonly evidenceRepository: EvidenceRepository,
    private readonly usage: UsageService,
    private readonly providerObservability: ProviderObservabilityService,
  ) {}

  async enqueueCompanyEnrichment(executionId: string, organizationId: string): Promise<Array<{ companyId: string; status: 'QUEUED'; jobId: string }>> {
    const rows = await this.db.select({ companyId: sourceRecords.companyId }).from(sourceRecords)
      .where(and(eq(sourceRecords.searchExecutionId, executionId), eq(sourceRecords.organizationId, organizationId)))
      .groupBy(sourceRecords.companyId);

    const enqueued: Array<{ companyId: string; status: 'QUEUED'; jobId: string }> = [];
    for (const row of rows) {
      if (!row.companyId) {
        continue;
      }
      const company = await this.companyRepository.findCompanyForOrganization(row.companyId, organizationId);
      if (!company) {
        continue;
      }
      const idempotencyKey = this.jobKey(company.id, organizationId, executionId);
      const [existingJob] = await this.db.select({ bullJobId: pipelineJobs.bullJobId }).from(pipelineJobs).where(eq(pipelineJobs.bullJobId, idempotencyKey)).limit(1);
      if (existingJob?.bullJobId) {
        enqueued.push({ companyId: company.id, status: 'QUEUED', jobId: existingJob.bullJobId });
        continue;
      }
      const job = await this.queue.enqueue({ companyId: company.id, organizationId, searchExecutionId: executionId, idempotencyKey });
      await this.db.insert(pipelineJobs).values({
        searchExecutionId: executionId,
        jobType: 'COMPANY_ENRICHMENT',
        status: 'QUEUED',
        bullJobId: idempotencyKey,
      });
      enqueued.push({ companyId: company.id, status: 'QUEUED', jobId: String(job.id) });
    }
    return enqueued;
  }

  async enqueueForCompany(companyId: string, organizationId: string, searchExecutionId?: string | null): Promise<{ companyId: string; status: 'QUEUED'; jobId: string }> {
    const company = await this.companyRepository.findCompanyForOrganization(companyId, organizationId);
    if (!company) {
      throw new NotFoundException('Company not found');
    }

    await this.usage.checkRequestRate(organizationId, undefined, 'WEBSITE_FETCH');
    const idempotencyKey = this.jobKey(company.id, organizationId, searchExecutionId ?? null);
    const [existingJob] = await this.db.select({ bullJobId: pipelineJobs.bullJobId }).from(pipelineJobs).where(eq(pipelineJobs.bullJobId, idempotencyKey)).limit(1);
    if (existingJob?.bullJobId) return { companyId: company.id, status: 'QUEUED', jobId: existingJob.bullJobId };
    const job = await this.queue.enqueue({ companyId: company.id, organizationId, searchExecutionId: searchExecutionId ?? null, idempotencyKey });
    await this.db.insert(pipelineJobs).values({
      searchExecutionId: searchExecutionId ?? null,
      jobType: 'COMPANY_ENRICHMENT',
      status: 'QUEUED',
      bullJobId: idempotencyKey,
    });
    return { companyId: company.id, status: 'QUEUED', jobId: String(job.id) };
  }

  async runCompanyEnrichment(data: CompanyEnrichmentJobData) {
    const { companyId, organizationId } = data;
    const company = await this.companyRepository.findCompanyForOrganization(companyId, organizationId);
    if (!company) {
      throw new NotFoundException('Company not found');
    }

    await this.usage.checkRequestRate(organizationId, undefined, 'WEBSITE_FETCH');
    try {
      const result = await this.providerObservability.track('website', 'ENRICHMENT', async () => ({ value: await this.enrichPages(company) }));
      await this.usage.recordUsage({ organizationId, operation: 'WEBSITE_FETCH', provider: 'website', resourceType: 'company', resourceId: company.id, units: Math.max(1, result.pagesFetched), status: 'COMPLETED', metadata: { pagesFetched: result.pagesFetched, fieldsExtracted: result.fieldsExtracted, websiteStatus: result.websiteStatus, ...(result.message ? { message: result.message } : {}) } });
      await this.db.insert(auditLogs).values({ organizationId, entityId: company.id, action: 'COMPANY_ENRICHMENT_COMPLETED', entityType: 'company', metadata: { companyId: company.id, pagesFetched: result.pagesFetched, fieldsExtracted: result.fieldsExtracted, websiteStatus: result.websiteStatus, ...(result.message ? { message: result.message } : {}) } });
      return { companyId, organizationId, website: result.website, websiteStatus: result.websiteStatus, message: result.message, socialProfiles: result.socialProfiles, fieldsExtracted: result.fieldsExtracted };
    } catch (error) {
      await this.usage.recordUsage({ organizationId, operation: 'WEBSITE_FETCH', provider: 'website', resourceType: 'company', resourceId: company.id, units: 1, status: 'FAILED' });
      throw error;
    }
  }

  private async enrichPages(company: typeof companies.$inferSelect) {
    const located = await this.companyRepository.findCompanyWithLocation(company.id, company.organizationId);
    const location = located?.location ?? null;
    const sources = await this.db.select({
      sourceUrl: sourceRecords.sourceUrl,
      sourceType: sourceRecords.sourceType,
      rawData: sourceRecords.rawData,
    }).from(sourceRecords).where(and(eq(sourceRecords.companyId, company.id), eq(sourceRecords.organizationId, company.organizationId)));
    const attempt = sources.find((row) => Boolean(row.sourceUrl)) ?? null;
    const websiteResult = await this.discovery.discover({
      existingWebsite: company.website ?? null,
      companyName: company.name,
      city: location?.city ?? null,
      state: location?.state ?? null,
      country: location?.country ?? null,
      sourceWebsites: sources.flatMap((row) => websitesFromSourceRaw(row.rawData)),
      attemptSourceUrl: attempt?.sourceUrl ?? null,
      attemptSourceType: attempt?.sourceType ?? null,
      category: company.category ?? null,
    });
    const updates: Partial<typeof companies.$inferInsert> = {};
    const replacingRejectedWebsite = Boolean(websiteResult.clearStoredWebsite && company.website && company.verificationStatus !== 'VERIFIED');
    if (websiteResult.status === 'FOUND' && websiteResult.website && (!company.website || replacingRejectedWebsite)) updates.website = websiteResult.website;
    if (websiteResult.status !== 'FOUND' && replacingRejectedWebsite) updates.website = null;
    const pages = websiteResult.pages ?? (websiteResult.page ? [websiteResult.page] : []);
    const discoveredSocial = new Set<string>();
    let fieldsExtracted = 0;
    for (const page of pages) {
      const parsed = this.parser.parsePage(page.finalUrl, page.content);
      fieldsExtracted += parsed.evidence.length;
      if (!company.description && parsed.description && !updates.description) updates.description = parsed.description;
      if (!company.phone && parsed.phone && !updates.phone) updates.phone = parsed.phone;
      if (!company.email && parsed.publicEmail && !updates.email) updates.email = parsed.publicEmail;
      if (!company.investmentStrategy && parsed.investmentStrategy && !updates.investmentStrategy) updates.investmentStrategy = parsed.investmentStrategy;
      if (!company.marketsServed && parsed.marketsServed?.length) updates.marketsServed = parsed.marketsServed;
      if (!company.propertyTypes && parsed.propertyTypes?.length) updates.propertyTypes = parsed.propertyTypes;
      await this.evidenceRepository.persistEvidence(company.id, page.finalUrl, parsed.evidence, page.canonicalUrl ?? websiteResult.website ?? undefined);
      for (const socialUrl of this.socialDiscovery.discover(page.content, page.finalUrl)) discoveredSocial.add(socialUrl);
    }
    const evidenceWebsite = replacingRejectedWebsite ? websiteResult.website : (company.website || websiteResult.website);
    if (websiteResult.status === 'FOUND' && websiteResult.website && websiteResult.searchHit) {
      const officialWebsite = evidenceWebsite || websiteResult.website;
      await this.evidenceRepository.persistEvidence(company.id, websiteResult.searchHit.url, [{
        field: 'website',
        value: officialWebsite,
        sourceUrl: websiteResult.searchHit.url,
        evidenceExcerpt: websiteResult.searchHit.snippet || websiteResult.searchHit.title || officialWebsite,
        retrievedAt: websiteResult.searchHit.retrievedAt,
        evidenceType: 'META_DATA',
      }], officialWebsite, { provider: websiteResult.searchHit.source, sourceType: 'WEB_SEARCH', verified: false });
    }
    if (websiteResult.status === 'FOUND' && websiteResult.website && websiteResult.sourceUrl) {
      const officialWebsite = evidenceWebsite || websiteResult.website;
      await this.evidenceRepository.persistEvidence(company.id, websiteResult.sourceUrl, [{
        field: 'website',
        value: officialWebsite,
        sourceUrl: websiteResult.sourceUrl,
        evidenceExcerpt: websiteResult.evidenceExcerpt || officialWebsite,
        retrievedAt: websiteResult.retrievedAt || new Date().toISOString(),
        evidenceType: 'WEBSITE',
      }], officialWebsite, { provider: websiteResult.searchHit?.source ?? websiteResult.provider ?? 'official_website', sourceType: 'WEBSITE', verified: false });
    }
    for (const rejected of websiteResult.rejectedSearchHits ?? []) {
      await this.evidenceRepository.persistEvidence(company.id, rejected.hit.url, [{
        field: 'website',
        value: rejected.reason,
        sourceUrl: rejected.hit.url,
        evidenceExcerpt: rejected.hit.snippet || rejected.hit.title || rejected.reason,
        retrievedAt: rejected.hit.retrievedAt,
        evidenceType: 'META_DATA',
      }], undefined, { provider: rejected.hit.source, sourceType: 'WEB_SEARCH', verified: false });
    }
    if (websiteResult.status === 'NOT_FOUND' && (!company.website || replacingRejectedWebsite) && websiteResult.sourceUrl) {
      const excerpt = websiteResult.evidenceExcerpt || websiteResult.reason || 'No verified website found.';
      await this.evidenceRepository.persistEvidence(company.id, websiteResult.sourceUrl, [{
        field: 'website',
        value: 'NOT_FOUND',
        sourceUrl: websiteResult.sourceUrl,
        evidenceExcerpt: excerpt,
        retrievedAt: websiteResult.retrievedAt || new Date().toISOString(),
        evidenceType: 'META_DATA',
      }], undefined, { provider: 'website_discovery', sourceType: websiteResult.sourceType ?? attempt?.sourceType ?? 'WEBSITE', verified: false });
    }
    for (const socialUrl of discoveredSocial) {
      const host = new URL(socialUrl).hostname.toLowerCase();
      const platform = host.includes('linkedin') ? 'linkedin' : host.includes('facebook') ? 'facebook' : host.includes('instagram') ? 'instagram' : host.includes('youtube') ? 'youtube' : host.includes('x.com') || host.includes('twitter') ? 'x' : 'other';
      if (platform !== 'other') await this.companyRepository.upsertSocialProfile(company.id, platform, socialUrl, null);
    }
    if (Object.keys(updates).length > 0) await this.companyRepository.updateCompany(company.id, updates);
    const retainedWebsite = replacingRejectedWebsite ? null : company.website;
    const officialWebsite = retainedWebsite || (websiteResult.status === 'FOUND' ? websiteResult.website : null);
    const nothingNew = Object.keys(updates).length === 0 && fieldsExtracted === 0 && discoveredSocial.size === 0;
    return {
      website: officialWebsite,
      websiteStatus: officialWebsite ? 'FOUND' as const : 'NOT_FOUND' as const,
      message: nothingNew ? 'No additional verified enrichment data found.' : undefined,
      socialProfiles: [...discoveredSocial],
      pagesFetched: pages.length,
      fieldsExtracted,
    };
  }

  private jobKey(companyId: string, organizationId: string, searchExecutionId: string | null) {
    return `company-enrichment-${createHash('sha256').update(`${organizationId}:${companyId}:${searchExecutionId ?? 'direct'}`).digest('hex')}`;
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
