import { createHash } from 'node:crypto';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { OpenRouterProvider } from '../ai/classification/providers/openrouter.provider';
import { StructuredLoggerService } from '../common/observability/structured-logger.service';
import { DRIZZLE } from '../database/database.constants';
import type { Database } from '../database/database.types';
import { companies, companyContacts, companyLocations, companySocialProfiles, leadEvidence, researchExecutions } from '../database/schema/schema';
import { EvidenceRepository } from '../enrichment/repositories/evidence.repository';
import { WebsiteFetchService } from '../enrichment/website/website-fetch.service';
import { WebsiteNormalizerService } from '../enrichment/website/website-normalizer.service';
import { WebsiteParserService } from '../enrichment/website/website-parser.service';
import type { SourceEvidence } from '../enrichment/website/website.types';
import { ContactQualityService } from '../contacts/quality/contact-quality.service';
import { UsageService } from '../usage/usage.service';
import { VerificationService } from '../verification/verification.service';
import { DeepResearchJobData, ResearchQueue } from './research.queue';
import {
  acceptAiClaim,
  validatedResearchClaims,
  classifyPageFailure,
  extractDecisionMakerCandidates,
  extractExplicitSocialLinks,
  extractLiteralEmails,
  extractLiteralPhones,
  extractPageLinks,
  extractVisibleText,
  planResearchPages,
  researchStopReason,
} from './research.planner';

@Injectable()
export class ResearchService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly config: ConfigService,
    private readonly queue: ResearchQueue,
    private readonly fetcher: WebsiteFetchService,
    private readonly normalizer: WebsiteNormalizerService,
    private readonly parser: WebsiteParserService,
    private readonly evidence: EvidenceRepository,
    private readonly openRouter: OpenRouterProvider,
    private readonly verification: VerificationService,
    private readonly contactQuality: ContactQualityService,
    private readonly usage: UsageService,
    private readonly logger: StructuredLoggerService,
  ) {}

  async start(companyId: string, organizationId: string) {
    const company = await this.findCompany(companyId, organizationId);
    const [active] = await this.db.select().from(researchExecutions).where(and(
      eq(researchExecutions.companyId, company.id),
      eq(researchExecutions.organizationId, organizationId),
      inArray(researchExecutions.status, ['QUEUED', 'RUNNING']),
    )).orderBy(desc(researchExecutions.createdAt)).limit(1);
    if (active) return { researchExecutionId: active.id, status: active.status };
    const [created] = await this.db.insert(researchExecutions).values({ organizationId, companyId: company.id, status: 'QUEUED' }).returning();
    const jobId = `deep-research-${createHash('sha256').update(`${organizationId}-${company.id}-${created.id}`).digest('hex')}`;
    await this.queue.enqueue({ organizationId, companyId: company.id, researchExecutionId: created.id }, jobId);
    this.logger.info('job.deep_research.queued', { jobId, organizationId, companyId: company.id, researchExecutionId: created.id });
    return { researchExecutionId: created.id, status: 'QUEUED' as const };
  }

  async list(companyId: string, organizationId: string) {
    await this.findCompany(companyId, organizationId);
    return this.db.select().from(researchExecutions).where(and(eq(researchExecutions.companyId, companyId), eq(researchExecutions.organizationId, organizationId))).orderBy(desc(researchExecutions.createdAt));
  }

  async get(companyId: string, researchExecutionId: string, organizationId: string) {
    const [row] = await this.db.select().from(researchExecutions).where(and(
      eq(researchExecutions.id, researchExecutionId),
      eq(researchExecutions.companyId, companyId),
      eq(researchExecutions.organizationId, organizationId),
    )).limit(1);
    if (!row) throw new NotFoundException('Research execution not found');
    return {
      ...row,
      progress: {
        pagesDiscovered: row.pagesDiscovered,
        pagesProcessed: row.pagesProcessed,
        fieldsExtracted: row.fieldsExtracted,
        fieldsVerified: row.fieldsVerified,
        conflictsFound: row.conflictsFound,
      },
      failures: row.pageFailures,
    };
  }

  async runQueued(data: DeepResearchJobData) {
    const company = await this.findCompany(data.companyId, data.organizationId);
    const execution = await this.get(data.companyId, data.researchExecutionId, data.organizationId);
    const limits = this.limits();
    const started = Date.now();
    await this.db.update(researchExecutions).set({ status: 'RUNNING', startedAt: new Date(), updatedAt: new Date() }).where(eq(researchExecutions.id, execution.id));
    const website = this.normalizer.normalizeUrl(company.website);
    if (!website) return this.finish(execution.id, 'FAILED', 'WEBSITE_NOT_FOUND', 'No canonical website is stored for this company.', [], 0, 0, 0, 0);
    try {
      await this.usage.assertDailyQuota(data.organizationId, 'ENRICHMENT');
    } catch (error) {
      return this.finish(execution.id, 'FAILED', 'QUOTA', error instanceof Error ? error.message : 'Research quota was reached.', [], 0, 0, 0, 0);
    }

    const failures: Array<{ url: string; message: string; permanent: boolean }> = [];
    const pages: Array<{ url: string; html: string; text: string }> = [];
    let discovered = 0;
    let stopReason = 'RELEVANT_PAGES_EXHAUSTED';
    const home = await this.fetchOne(website, limits.requestTimeoutMs, limits.maxRetries);
    if (!home.html) {
      failures.push({ url: website, message: home.message, permanent: home.permanent });
      return this.finish(execution.id, 'FAILED', home.permanent ? 'PAGE_ACCESS_DENIED' : 'FETCH_FAILED', home.message, failures, 1, 0, 0, 0);
    }
    const links = extractPageLinks(home.html, home.finalUrl, 1);
    const plan = planResearchPages(home.finalUrl, links, limits.maxPages, limits.maxDepth);
    discovered = plan.selected.length;
    const queue = [...plan.selected];
    while (queue.length > 0) {
      if (Date.now() - started > limits.timeoutMs) { stopReason = 'TIMEOUT'; break; }
      const batch = queue.splice(0, limits.concurrency);
      const results = await Promise.all(batch.map(async (page) => ({ page, result: page.url === this.normalizer.normalizeUrl(home.finalUrl) ? home : await this.fetchOne(page.url, limits.requestTimeoutMs, limits.maxRetries) })));
      for (const item of results) {
        if (!item.result.html) failures.push({ url: item.page.url, message: item.result.message, permanent: item.result.permanent });
        else pages.push({ url: item.result.finalUrl, html: item.result.html, text: extractVisibleText(item.result.html) });
      }
      const snapshot = this.collect(company.name, pages);
      stopReason = researchStopReason({
        timedOut: Date.now() - started > limits.timeoutMs,
        quotaReached: false,
        pagesProcessed: pages.length + failures.length,
        maxPages: limits.maxPages,
        pendingRelevant: queue.length,
        hasDescription: snapshot.evidence.some((entry) => entry.field === 'description'),
        hasContact: snapshot.evidence.some((entry) => entry.field === 'email' || entry.field === 'phone'),
        pendingLeadership: queue.filter((page) => page.score >= 8).length,
      });
      if (stopReason === 'TIMEOUT' || stopReason === 'SUFFICIENT_EVIDENCE' || stopReason === 'PAGE_BUDGET') break;
    }

    const collected = this.collect(company.name, pages);
    const aiClaims = await this.aiClaims(pages, limits.maxContentChars);
    const evidence = this.dedupeEvidence([...collected.evidence, ...aiClaims]);
    const stored = await this.evidence.persistEvidence(company.id, website, evidence, website);
    await this.applyCompanyFields(company, collected);
    await this.persistSocialProfiles(company.id, collected.socials);
    const contactIds = await this.persistPeople(company.id, company.name, collected.people, collected.personEmails, collected.personPhones);
    let fieldsVerified = 0;
    let conflictsFound = 0;
    for (const contactId of contactIds) {
      const quality = await this.contactQuality.verifyQueued({ organizationId: data.organizationId, companyId: company.id, contactId });
      if (quality.identityStatus === 'VERIFIED' || quality.identityStatus === 'SUPPORTED') fieldsVerified += 1;
      if (quality.duplicateStatus === 'NEEDS_REVIEW') conflictsFound += 1;
    }
    const rows = await this.verification.verifyQueued({
      companyId: company.id,
      contactId: null,
      organizationId: data.organizationId,
      searchExecutionId: null,
      force: true,
      idempotencyKey: createHash('sha256').update(`deep-research-${execution.id}`).digest('hex'),
    });
    fieldsVerified += rows.filter((row) => row.status === 'VERIFIED' || row.status === 'SUPPORTED').length;
    conflictsFound += rows.filter((row) => row.status === 'CONFLICT' || row.status === 'NEEDS_REVIEW').length;
    const status = pages.length > 0 && failures.length > 0 ? 'PARTIAL' : pages.length > 0 ? 'COMPLETED' : 'FAILED';
    await this.db.update(researchExecutions).set({
      status,
      completedAt: status === 'FAILED' ? null : new Date(),
      failedAt: status === 'FAILED' ? new Date() : null,
      pagesDiscovered: discovered,
      pagesProcessed: pages.length,
      fieldsExtracted: stored.length,
      fieldsVerified,
      conflictsFound,
      stopReason,
      pageFailures: failures,
      extractedFields: [
        ...evidence.map((entry) => ({ field: entry.field, status: 'CANDIDATE', sourceUrl: entry.sourceUrl })),
        ...(collected.missingEmail ? [{ field: 'email', status: 'NOT_FOUND' }] : []),
        ...(collected.socials.length ? [] : [{ field: 'linkedin', status: 'NOT_FOUND' }]),
      ],
      errorCode: status === 'FAILED' ? 'NO_PAGES_FETCHED' : null,
      errorMessage: status === 'FAILED' ? 'No public pages could be fetched.' : null,
      updatedAt: new Date(),
    }).where(eq(researchExecutions.id, execution.id));
    return { researchExecutionId: execution.id, status, pagesProcessed: pages.length };
  }

  private collect(companyName: string, pages: Array<{ url: string; html: string; text: string }>) {
    const roles = this.config.get<string[]>('decisionMaker.rolePriorities') ?? [];
    const evidence: SourceEvidence[] = [];
    const people: Array<{ name: string; title: string; excerpt: string; sourceUrl: string }> = [];
    const socials: Array<{ platform: string; url: string; sourceUrl: string }> = [];
    const personEmails: Array<{ name: string; email: string; sourceUrl: string; excerpt: string }> = [];
    const personPhones: Array<{ name: string; phone: string; sourceUrl: string; excerpt: string }> = [];
    const retrievedAt = new Date().toISOString();
    for (const page of pages) {
      const parsed = this.parser.parsePage(page.url, page.html);
      evidence.push(...parsed.evidence.map((entry) => ({ ...entry, sourceUrl: page.url, retrievedAt })));
      for (const email of extractLiteralEmails(page.text)) {
        evidence.push({ field: 'email', value: email, sourceUrl: page.url, evidenceExcerpt: email, retrievedAt, evidenceType: 'CONTACT_PAGE' });
      }
      for (const phone of extractLiteralPhones(page.text)) {
        evidence.push({ field: 'phone', value: phone, sourceUrl: page.url, evidenceExcerpt: phone, retrievedAt, evidenceType: 'CONTACT_PAGE' });
      }
      for (const profile of extractExplicitSocialLinks(page.html)) {
        socials.push({ ...profile, sourceUrl: page.url });
        evidence.push({ field: profile.platform, value: profile.url, sourceUrl: page.url, evidenceExcerpt: profile.url, retrievedAt, evidenceType: 'SOCIAL_LINK' });
      }
      for (const person of extractDecisionMakerCandidates(page.text, roles)) {
        if (!person.excerpt.toLowerCase().includes(companyName.toLowerCase())) continue;
        people.push({ ...person, sourceUrl: page.url });
        evidence.push({ field: 'title', value: person.title, sourceUrl: page.url, evidenceExcerpt: person.excerpt, retrievedAt, evidenceType: 'ABOUT_PAGE' });
        evidence.push({ field: 'fullName', value: person.name, sourceUrl: page.url, evidenceExcerpt: person.excerpt, retrievedAt, evidenceType: 'ABOUT_PAGE' });
        for (const email of extractLiteralEmails(person.excerpt)) personEmails.push({ name: person.name, email, sourceUrl: page.url, excerpt: person.excerpt });
        for (const phone of extractLiteralPhones(person.excerpt)) personPhones.push({ name: person.name, phone, sourceUrl: page.url, excerpt: person.excerpt });
      }
    }
    if (!evidence.some((entry) => entry.field === 'email')) {
      return { evidence, people, socials, personEmails, personPhones, missingEmail: true };
    }
    return { evidence, people, socials, personEmails, personPhones, missingEmail: false };
  }

  private async aiClaims(pages: Array<{ url: string; text: string }>, maxChars: number) {
    if (!pages.length) return [];
    const model = this.config.get<string>('openRouter.model');
    const apiKey = this.config.get<string>('openRouter.apiKey');
    if (!model || !apiKey) return [];
    try {
      const content = pages.map((page) => `URL: ${page.url}\n${page.text.slice(0, maxChars)}`).join('\n\n').slice(0, maxChars);
      const parsed = await this.openRouter.completeJson(
        'Extract only facts quoted from the supplied pages. Return JSON with company, people, contacts, socialProfiles, and claims. Each claim is {field,value,sourceUrl,evidenceExcerpt}. Use null when a fact is absent. Do not invent URLs, emails, phones, or people.',
        content,
      );
      const claims = validatedResearchClaims(parsed);
      return claims.flatMap((claim) => {
        if (!acceptAiClaim(claim, pages) || !claim.field || !claim.value || !claim.sourceUrl || !claim.evidenceExcerpt) return [];
        return [{ field: claim.field, value: claim.value, sourceUrl: claim.sourceUrl, evidenceExcerpt: claim.evidenceExcerpt, retrievedAt: new Date().toISOString(), evidenceType: 'WEBSITE' as const }];
      });
    } catch (error) {
      this.logger.warn('job.deep_research.ai_skipped', { errorType: error instanceof Error ? error.name : 'unknown' });
      return [];
    }
  }

  private async applyCompanyFields(company: typeof companies.$inferSelect, collected: { evidence: SourceEvidence[]; personEmails: Array<{ email: string }> }) {
    const description = collected.evidence.find((entry) => entry.field === 'description')?.value;
    const email = collected.evidence.find((entry) => (entry.field === 'email' || entry.field === 'publicEmail') && !collected.personEmails.some((item) => item.email === entry.value))?.value;
    const phone = collected.evidence.find((entry) => entry.field === 'phone')?.value;
    await this.db.update(companies).set({
      ...(company.description ? {} : description ? { description } : {}),
      ...(company.email ? {} : email ? { email } : {}),
      ...(company.phone ? {} : phone ? { phone } : {}),
      updatedAt: new Date(),
    }).where(eq(companies.id, company.id));
    const address = collected.evidence.find((entry) => entry.field === 'address')?.value;
    if (!address) return;
    const [existing] = await this.db.select({ id: companyLocations.id }).from(companyLocations).where(eq(companyLocations.companyId, company.id)).limit(1);
    if (!existing) await this.db.insert(companyLocations).values({ companyId: company.id, addressLine1: address, isPrimary: true });
  }

  private async persistSocialProfiles(companyId: string, socials: Array<{ platform: string; url: string }>) {
    for (const profile of socials) {
      await this.db.insert(companySocialProfiles).values({ companyId, platform: profile.platform, profileUrl: profile.url, verificationStatus: 'NOT_VERIFIED' }).onConflictDoNothing();
    }
  }

  private async persistPeople(companyId: string, companyName: string, people: Array<{ name: string; title: string; excerpt: string; sourceUrl: string }>, emails: Array<{ name: string; email: string; sourceUrl: string; excerpt: string }>, phones: Array<{ name: string; phone: string; sourceUrl: string; excerpt: string }>) {
    const ids: string[] = [];
    for (const person of people) {
      const [existing] = await this.db.select().from(companyContacts).where(and(eq(companyContacts.companyId, companyId), eq(companyContacts.fullName, person.name))).limit(1);
      const email = emails.find((item) => item.name === person.name)?.email ?? null;
      const phone = phones.find((item) => item.name === person.name)?.phone ?? null;
      const contact = existing ?? (await this.db.insert(companyContacts).values({
        companyId,
        fullName: person.name,
        title: person.title,
        companyRelationship: companyName.slice(0, 100),
        email,
        emailStatus: email ? 'FOUND' : 'NOT_FOUND',
        phone,
        phoneStatus: phone ? 'FOUND' : 'NOT_FOUND',
        source: person.sourceUrl,
        verificationStatus: 'NOT_VERIFIED',
      }).returning())[0];
      if (!contact) continue;
      ids.push(contact.id);
      await this.db.insert(leadEvidence).values({
        companyId,
        contactId: contact.id,
        evidenceType: 'ABOUT_PAGE',
        sourceType: 'WEBSITE',
        sourceUrl: person.sourceUrl,
        evidenceText: person.excerpt,
        evidenceTimestamp: new Date(),
        idempotencyKey: createHash('sha256').update(`${companyId}-${contact.id}-${person.sourceUrl}-${person.title}`).digest('hex'),
        metadata: { field: 'title', value: person.title, evidenceExcerpt: person.excerpt },
      }).onConflictDoNothing({ target: leadEvidence.idempotencyKey });
    }
    return ids;
  }

  private async fetchOne(url: string, timeoutMs: number, retries: number) {
    try {
      const page = await this.fetcher.fetchPage(url, { timeoutMs, retries });
      return { html: page.body, finalUrl: page.finalUrl, message: '', permanent: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Page fetch failed';
      return { html: '', finalUrl: url, message, permanent: classifyPageFailure(message) === 'PERMANENT' };
    }
  }

  private dedupeEvidence(evidence: SourceEvidence[]) {
    const seen = new Set<string>();
    return evidence.filter((entry) => {
      const key = `${entry.field}|${entry.sourceUrl}|${entry.value}`.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  async markInterrupted(data: DeepResearchJobData, error: unknown) {
    const message = error instanceof Error ? error.message : 'Deep research failed';
    await this.db.update(researchExecutions).set({
      status: 'FAILED',
      failedAt: new Date(),
      errorCode: 'RESEARCH_FAILED',
      errorMessage: message.slice(0, 500),
      updatedAt: new Date(),
    }).where(and(eq(researchExecutions.id, data.researchExecutionId), eq(researchExecutions.organizationId, data.organizationId), eq(researchExecutions.status, 'RUNNING')));
  }

  private async finish(id: string, status: 'FAILED', errorCode: string, errorMessage: string, failures: unknown[], pagesDiscovered: number, pagesProcessed: number, fieldsExtracted: number, fieldsVerified: number) {
    await this.db.update(researchExecutions).set({
      status,
      failedAt: new Date(),
      stopReason: errorCode === 'QUOTA' ? 'QUOTA' : errorCode,
      errorCode,
      errorMessage,
      pageFailures: failures,
      pagesDiscovered,
      pagesProcessed,
      fieldsExtracted,
      fieldsVerified,
      updatedAt: new Date(),
    }).where(eq(researchExecutions.id, id));
    return { researchExecutionId: id, status };
  }

  private limits() {
    return {
      maxPages: this.config.get<number>('deepResearch.maxPages', 8),
      maxDepth: this.config.get<number>('deepResearch.maxDepth', 1),
      timeoutMs: this.config.get<number>('deepResearch.timeoutMs', 120000),
      requestTimeoutMs: this.config.get<number>('deepResearch.requestTimeoutMs', 10000),
      concurrency: this.config.get<number>('deepResearch.concurrency', 2),
      maxRetries: this.config.get<number>('deepResearch.maxRetries', 2),
      maxContentChars: this.config.get<number>('deepResearch.maxContentChars', 8000),
    };
  }

  private async findCompany(companyId: string, organizationId: string) {
    const [company] = await this.db.select().from(companies).where(and(eq(companies.id, companyId), eq(companies.organizationId, organizationId))).limit(1);
    if (!company) throw new NotFoundException('Company not found');
    return company;
  }
}
