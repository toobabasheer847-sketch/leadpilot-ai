import { Inject, Injectable, Optional, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq } from 'drizzle-orm';
import { clampConcurrency, mapWithConcurrency } from '../../common/concurrency';
import { MetricsService } from '../../common/observability/metrics.service';
import { DRIZZLE } from '../../database/database.constants';
import type { Database } from '../../database/database.types';
import { companies, companyContacts, leadEvidence, searchExecutions, sourceRecords } from '../../database/schema/schema';
import { ContactsService } from '../../contacts/contacts.service';
import { contactDiscoveryRequested, employeeSizeRequested } from '../../search/search-plan.limits';
import type { SearchPlan } from '../../search/types/search-plan.types';
import { WEB_SEARCH_PROVIDER, type WebSearchProvider } from '../website/web-search.types';
import { WebsiteDiscoveryService, websitesFromSourceRaw } from '../website/website-discovery.service';
import { WebsiteParserService } from '../website/website-parser.service';
import { WebsiteFetchService } from '../website/website-fetch.service';
import { CompanySocialDiscoveryService } from '../social/company-social-discovery.service';
import { CompanyEnrichmentRepository } from '../repositories/company-enrichment.repository';
import { EvidenceRepository } from '../repositories/evidence.repository';
import { CompanyResearchContextService } from '../research-context/company-research-context.service';
import { EmployeeSizeService } from '../employee-size/employee-size.service';
import { assessmentNeedsRetry, assessCompanyCompleteness, type CompletenessSnapshot } from './completeness.assess';
import type { CompletenessPassStats, CompanyCompletenessAssessment } from './completeness.types';
import { MAX_COMPLETENESS_RETRIES_PER_COMPANY } from './completeness.types';

@Injectable()
export class CompletenessRetryService {
  private readonly concurrency: number;
  private readonly passed = new Set<string>();

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly companyRepository: CompanyEnrichmentRepository,
    private readonly evidenceRepository: EvidenceRepository,
    private readonly discovery: WebsiteDiscoveryService,
    private readonly parser: WebsiteParserService,
    private readonly fetcher: WebsiteFetchService,
    private readonly socialDiscovery: CompanySocialDiscoveryService,
    private readonly researchContext: CompanyResearchContextService,
    private readonly employeeSize: EmployeeSizeService,
    @Inject(forwardRef(() => ContactsService)) private readonly contacts: ContactsService,
    private readonly metrics: MetricsService,
    config: ConfigService,
    @Optional() @Inject(WEB_SEARCH_PROVIDER) private readonly webSearch?: WebSearchProvider,
  ) {
    this.concurrency = clampConcurrency(
      config.get<number>('enrichment.dispatchConcurrency') ?? config.get<number>('enrichment.concurrency'),
      4,
      16,
    );
  }

  resetForTests() {
    this.passed.clear();
  }

  async runForExecution(organizationId: string, searchExecutionId: string): Promise<CompletenessPassStats> {
    const started = Date.now();
    const plan = await this.loadPlan(searchExecutionId, organizationId);
    const companyIds = await this.listCompanyIds(organizationId, searchExecutionId);
    let companiesRetried = 0;
    let fieldsFilled = 0;
    let searchesSkipped = 0;
    let providerFailures = 0;

    await mapWithConcurrency(companyIds, this.concurrency, async (companyId) => {
      const passKey = `${organizationId}:${companyId}:${searchExecutionId}`;
      if (this.passed.has(passKey)) return null;
      try {
        const before = await this.assess(companyId, organizationId, searchExecutionId, plan);
        if (!assessmentNeedsRetry(before)) {
          this.passed.add(passKey);
          return null;
        }
        companiesRetried += 1;
        const filled = await this.fillGaps(companyId, organizationId, searchExecutionId, plan, before);
        fieldsFilled += filled.fieldsFilled;
        searchesSkipped += filled.searchesSkipped;
        providerFailures += filled.providerFailures;
        this.passed.add(passKey);
        this.researchContext.observeDuration(companyId, Date.now() - started);
      } catch {
        providerFailures += 1;
        this.passed.add(passKey);
      }
      return companyId;
    }, { maxConcurrency: 16 });

    const stats: CompletenessPassStats = {
      companiesAssessed: companyIds.length,
      companiesRetried,
      fieldsFilled,
      searchesSkipped,
      providerFailures,
      durationMs: Date.now() - started,
    };
    this.metrics.observe('completeness_pass_duration_ms', stats.durationMs, { scope: 'execution' });
    this.metrics.increment('completeness_companies_assessed_total', { scope: 'execution' });
    for (let i = 0; i < companiesRetried; i += 1) this.metrics.increment('completeness_companies_retried_total', {});
    for (let i = 0; i < fieldsFilled; i += 1) this.metrics.increment('completeness_fields_filled_total', {});
    return stats;
  }

  async assess(
    companyId: string,
    organizationId: string,
    searchExecutionId: string | null,
    plan?: unknown,
  ): Promise<CompanyCompletenessAssessment> {
    const snapshot = await this.loadSnapshot(companyId, organizationId);
    if (!snapshot) {
      return {
        companyId,
        organizationId,
        fields: [],
        missingRequested: [],
        needsWebsite: false,
        needsCompanyContacts: false,
        needsCompanySocial: false,
        needsDecisionMaker: false,
        needsPersonSocial: false,
        needsPersonEmail: false,
        needsEmployeeSize: false,
      };
    }
    const resolvedPlan = plan ?? (searchExecutionId ? await this.loadPlan(searchExecutionId, organizationId) : null);
    return assessCompanyCompleteness(snapshot, resolvedPlan);
  }

  private async fillGaps(
    companyId: string,
    organizationId: string,
    searchExecutionId: string,
    plan: unknown,
    assessment: CompanyCompletenessAssessment,
  ): Promise<{ fieldsFilled: number; searchesSkipped: number; providerFailures: number }> {
    let fieldsFilled = 0;
    let searchesSkipped = 0;
    let providerFailures = 0;
    const contextKey = { organizationId, companyId, searchExecutionId };
    const located = await this.companyRepository.findCompanyWithLocation(companyId, organizationId);
    if (!located?.company) return { fieldsFilled, searchesSkipped, providerFailures };
    const company = located.company;
    const location = located.location;

    if (assessment.needsWebsite && !company.website) {
      try {
        const sources = await this.db.select({
          sourceUrl: sourceRecords.sourceUrl,
          sourceType: sourceRecords.sourceType,
          rawData: sourceRecords.rawData,
        }).from(sourceRecords).where(and(eq(sourceRecords.companyId, companyId), eq(sourceRecords.organizationId, organizationId)));
        const result = await this.discovery.discover({
          existingWebsite: company.website,
          companyName: company.name,
          city: location?.city ?? null,
          state: location?.state ?? null,
          country: location?.country ?? null,
          sourceWebsites: sources.flatMap((row) => websitesFromSourceRaw(row.rawData)),
          attemptSourceUrl: sources.find((row) => row.sourceUrl)?.sourceUrl ?? null,
          attemptSourceType: sources.find((row) => row.sourceUrl)?.sourceType ?? null,
          category: company.category,
        });
        if (result.status === 'FOUND' && result.website) {
          await this.companyRepository.updateCompany(companyId, { website: result.website });
          const pages = result.pages ?? (result.page ? [result.page] : []);
          if (pages.length) await this.researchContext.mergePages(contextKey, pages, 'completeness', { name: company.name, website: result.website });
          fieldsFilled += 1;
        }
        if (result.searchHit) await this.researchContext.recordSearchHits(contextKey, `${company.name} website completeness`, [result.searchHit]);
      } catch {
        providerFailures += 1;
      }
    }

    const refreshed = await this.companyRepository.findCompanyForOrganization(companyId, organizationId);
    const website = refreshed?.website ?? company.website;

    if ((assessment.needsCompanyContacts || assessment.needsCompanySocial) && website) {
      try {
        const filled = await this.fillFromWebsitePages(companyId, organizationId, searchExecutionId, website, company.name, assessment);
        fieldsFilled += filled.fieldsFilled;
        searchesSkipped += filled.searchesSkipped;
      } catch {
        providerFailures += 1;
      }
    }

    if (assessment.needsCompanySocial) {
      try {
        const filled = await this.fillCompanySocialFromSearch(companyId, organizationId, searchExecutionId, company.name, assessment);
        fieldsFilled += filled.fieldsFilled;
        searchesSkipped += filled.searchesSkipped;
        providerFailures += filled.providerFailures;
      } catch {
        providerFailures += 1;
      }
    }

    if ((assessment.needsDecisionMaker || assessment.needsPersonSocial || assessment.needsPersonEmail) && contactDiscoveryRequested(plan)) {
      try {
        await this.contacts.discoverForCompany(companyId, organizationId, searchExecutionId);
        const after = await this.assess(companyId, organizationId, searchExecutionId, plan);
        const beforeMissing = new Set(assessment.missingRequested);
        fieldsFilled += after.fields.filter((field) => beforeMissing.has(field.field) && field.state !== 'NOT_FOUND' && field.state !== 'UNKNOWN').length;
      } catch {
        providerFailures += 1;
      }
    }

    if (assessment.needsEmployeeSize && employeeSizeRequested(plan)) {
      try {
        const outcome = await this.employeeSize.collect({ organizationId, companyId });
        if (outcome === 'FOUND') fieldsFilled += 1;
      } catch {
        providerFailures += 1;
      }
    }

    void MAX_COMPLETENESS_RETRIES_PER_COMPANY;
    return { fieldsFilled, searchesSkipped, providerFailures };
  }

  private async fillFromWebsitePages(
    companyId: string,
    organizationId: string,
    searchExecutionId: string,
    website: string,
    companyName: string,
    assessment: CompanyCompletenessAssessment,
  ) {
    let fieldsFilled = 0;
    let searchesSkipped = 0;
    const contextKey = { organizationId, companyId, searchExecutionId };
    let pages = await this.researchContext.getPages(contextKey);
    if (pages.length) searchesSkipped += 1;
    if (!pages.length) {
      // Also try the null-execution key used by some stages historically.
      pages = await this.researchContext.getPages({ organizationId, companyId, searchExecutionId: null });
      if (pages.length) searchesSkipped += 1;
    }
    if (!pages.length) {
      try {
        const home = await this.fetcher.fetchPage(website, { retries: 0 });
        pages = [{
          url: home.url,
          finalUrl: home.finalUrl,
          title: home.title ?? null,
          content: home.body,
          contentType: home.contentType,
          statusCode: home.statusCode,
          fetchedAt: new Date().toISOString(),
          sourceStage: 'completeness',
        }];
        await this.researchContext.mergePages(contextKey, pages, 'completeness', { name: companyName, website });
      } catch {
        return { fieldsFilled, searchesSkipped };
      }
    }

    const updates: Record<string, string> = {};
    const socials = new Set<string>();
    for (const page of pages) {
      const parsed = this.parser.parsePage(page.finalUrl || page.url, page.content);
      if (assessment.needsCompanyContacts) {
        if (!updates.phone && parsed.phone) updates.phone = parsed.phone;
        if (!updates.email && parsed.publicEmail) updates.email = parsed.publicEmail;
        if (parsed.evidence.length) {
          await this.evidenceRepository.persistEvidence(companyId, page.finalUrl || page.url, parsed.evidence, website, {
            provider: 'completeness_reuse',
            sourceType: 'WEBSITE',
            verified: false,
          });
        }
      }
      if (assessment.needsCompanySocial) {
        for (const social of this.socialDiscovery.discover(page.content, page.finalUrl || page.url)) socials.add(social);
      }
    }

    const company = await this.companyRepository.findCompanyForOrganization(companyId, organizationId);
    if (company) {
      const patch: Partial<typeof companies.$inferInsert> = {};
      if (!company.phone && updates.phone) { patch.phone = updates.phone; fieldsFilled += 1; }
      if (!company.email && updates.email) { patch.email = updates.email; fieldsFilled += 1; }
      if (Object.keys(patch).length) await this.companyRepository.updateCompany(companyId, patch);
    }

    for (const socialUrl of socials) {
      const platform = platformFromUrl(socialUrl);
      if (!platform) continue;
      await this.companyRepository.upsertSocialProfile(companyId, platform, socialUrl, null);
      await this.evidenceRepository.persistEvidence(companyId, socialUrl, [{
        field: 'socialProfile',
        value: socialUrl,
        sourceUrl: socialUrl,
        evidenceExcerpt: socialUrl,
        retrievedAt: new Date().toISOString(),
        evidenceType: 'SOCIAL_LINK',
      }], undefined, { provider: 'completeness_reuse', sourceType: 'WEBSITE', verified: false });
      fieldsFilled += 1;
    }

    return { fieldsFilled, searchesSkipped };
  }

  private async fillCompanySocialFromSearch(
    companyId: string,
    organizationId: string,
    searchExecutionId: string,
    companyName: string,
    assessment: CompanyCompletenessAssessment,
  ) {
    let fieldsFilled = 0;
    let searchesSkipped = 0;
    let providerFailures = 0;
    if (!this.webSearch || typeof this.webSearch.searchText !== 'function') return { fieldsFilled, searchesSkipped, providerFailures };
    const contextKey = { organizationId, companyId, searchExecutionId };
    const existing = await this.companyRepository.getSocialProfiles(companyId, organizationId);
    const have = new Set(existing.map((row) => row.platform));
    const missing = missingSocialPlatforms(assessment, have);
    if (!missing.length) return { fieldsFilled, searchesSkipped, providerFailures };

    for (const platform of missing) {
      const query = `"${companyName}" ${platform} company`;
      if (await this.researchContext.shouldSkipQuery(contextKey, query)) {
        searchesSkipped += 1;
        const cached = await this.researchContext.getSearchHits(contextKey, query);
        const urls = this.socialDiscovery.fromSearchHits(companyName, cached.map((hit) => ({ url: hit.url, title: hit.title, snippet: hit.snippet })));
        for (const url of urls) {
          await this.companyRepository.upsertSocialProfile(companyId, platformFromUrl(url) ?? platform, url, null);
          fieldsFilled += 1;
        }
        continue;
      }
      try {
        const hits = await this.webSearch.searchText(query, { maxResults: 5 });
        await this.researchContext.markQueryIssued(contextKey, query);
        await this.researchContext.recordSearchHits(contextKey, query, hits);
        const urls = this.socialDiscovery.fromSearchHits(companyName, hits);
        for (const url of urls) {
          const resolved = platformFromUrl(url) ?? platform;
          await this.companyRepository.upsertSocialProfile(companyId, resolved, url, null);
          await this.evidenceRepository.persistEvidence(companyId, url, [{
            field: 'socialProfile',
            value: url,
            sourceUrl: url,
            evidenceExcerpt: hits.find((hit) => hit.url === url)?.snippet || url,
            retrievedAt: new Date().toISOString(),
            evidenceType: 'SOCIAL_LINK',
          }], undefined, { provider: 'web_search', sourceType: 'WEB_SEARCH', verified: false });
          fieldsFilled += 1;
        }
      } catch {
        providerFailures += 1;
        await this.researchContext.markQueryIssued(contextKey, query);
      }
    }
    return { fieldsFilled, searchesSkipped, providerFailures };
  }

  private async loadSnapshot(companyId: string, organizationId: string): Promise<CompletenessSnapshot | null> {
    const located = await this.companyRepository.findCompanyWithLocation(companyId, organizationId);
    if (!located?.company) return null;
    const company = located.company;
    const location = located.location;
    const socials = await this.companyRepository.getSocialProfiles(companyId, organizationId);
    const contacts = await this.db.select({
      fullName: companyContacts.fullName,
      title: companyContacts.title,
      email: companyContacts.email,
      linkedinUrl: companyContacts.linkedinUrl,
      facebookUrl: companyContacts.facebookUrl,
      instagramUrl: companyContacts.instagramUrl,
      youtubeUrl: companyContacts.youtubeUrl,
      verificationStatus: companyContacts.verificationStatus,
    }).from(companyContacts)
      .innerJoin(companies, eq(companies.id, companyContacts.companyId))
      .where(and(
        eq(companyContacts.companyId, companyId),
        eq(companies.organizationId, organizationId),
      ));
    const sizeEvidence = await this.db.select({ id: leadEvidence.id }).from(leadEvidence).where(and(
      eq(leadEvidence.companyId, companyId),
      eq(leadEvidence.evidenceType, 'EMPLOYEE_SIZE'),
    )).limit(1);

    return {
      companyId,
      organizationId,
      name: company.name,
      category: company.category,
      website: company.website,
      phone: company.phone,
      email: company.email,
      description: company.description,
      employeeCount: company.employeeCount,
      employeeRange: company.employeeRange,
      verificationStatus: company.verificationStatus,
      city: location?.city ?? null,
      state: location?.state ?? null,
      country: location?.country ?? null,
      address: location?.addressLine1 ?? null,
      socialPlatforms: socials.map((row) => row.platform),
      contacts: contacts.map((row) => ({
        fullName: row.fullName,
        title: row.title,
        email: row.email,
        linkedinUrl: row.linkedinUrl,
        facebookUrl: row.facebookUrl,
        instagramUrl: row.instagramUrl,
        twitterUrl: null,
        verificationStatus: row.verificationStatus,
      })),
      hasSizeEvidence: sizeEvidence.length > 0,
    };
  }

  private async loadPlan(searchExecutionId: string, organizationId: string): Promise<SearchPlan | null> {
    const [row] = await this.db.select({ plan: searchExecutions.structuredPlan }).from(searchExecutions).where(and(
      eq(searchExecutions.id, searchExecutionId),
      eq(searchExecutions.organizationId, organizationId),
    )).limit(1);
    return row?.plan && typeof row.plan === 'object' ? row.plan as SearchPlan : null;
  }

  private async listCompanyIds(organizationId: string, searchExecutionId: string): Promise<string[]> {
    const rows = await this.db.select({ companyId: sourceRecords.companyId }).from(sourceRecords)
      .where(and(eq(sourceRecords.searchExecutionId, searchExecutionId), eq(sourceRecords.organizationId, organizationId)))
      .groupBy(sourceRecords.companyId);
    return rows.map((row) => row.companyId).filter((id): id is string => Boolean(id));
  }
}

function platformFromUrl(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.includes('linkedin')) return 'linkedin';
    if (host.includes('facebook')) return 'facebook';
    if (host.includes('instagram')) return 'instagram';
    if (host.includes('youtube') || host.includes('youtu.be')) return 'youtube';
    if (host.includes('twitter') || host === 'x.com' || host.endsWith('.x.com')) return 'x';
    return null;
  } catch {
    return null;
  }
}

function missingSocialPlatforms(assessment: CompanyCompletenessAssessment, have: Set<string>): string[] {
  const missing: string[] = [];
  const map: Array<[string, string]> = [
    ['companyLinkedin', 'linkedin'],
    ['companyFacebook', 'facebook'],
    ['companyInstagram', 'instagram'],
    ['companyTwitter', 'x'],
    ['companyYoutube', 'youtube'],
  ];
  for (const [field, platform] of map) {
    if (assessment.missingRequested.includes(field as never) && !have.has(platform) && !(platform === 'x' && have.has('twitter'))) {
      missing.push(platform === 'x' ? 'twitter' : platform);
    }
  }
  return missing;
}
