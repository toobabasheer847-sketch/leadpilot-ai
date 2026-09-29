import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE } from '../../database/database.constants';
import type { Database } from '../../database/database.types';
import { companies, companyLocations, leadEvidence, verificationConflicts } from '../../database/schema/schema';
import { visibleText } from '../website/web-search.query';
import { buildWebSearchQuery } from '../website/web-search.query';
import { WEB_SEARCH_PROVIDER, type WebSearchProvider } from '../website/web-search.types';
import { WebsiteFetchService } from '../website/website-fetch.service';
import { CompanyResearchContextService } from '../research-context/company-research-context.service';
import { collectEmployeeSizeEvidence, toEmployeeSizeEvidence, type EmployeeSizeAssessment, type EmployeeSizeFinding, type EmployeeSizePage } from './employee-size.collect';
import type { EmployeeSizeSubject } from './employee-size.identity';

export interface EmployeeSizeJobData {
  organizationId: string;
  companyId: string;
}

@Injectable()
export class EmployeeSizeService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(WEB_SEARCH_PROVIDER) private readonly search: WebSearchProvider,
    private readonly fetch: WebsiteFetchService,
    private readonly researchContext: CompanyResearchContextService,
  ) {}

  async collect(data: EmployeeSizeJobData): Promise<'FOUND' | 'NOT_FOUND' | 'CONFLICT'> {
    const started = Date.now();
    const subject = await this.loadSubject(data.organizationId, data.companyId);
    if (!subject) return 'NOT_FOUND';
    const contextKey = { organizationId: data.organizationId, companyId: data.companyId, searchExecutionId: null };
    const assessment = await collectEmployeeSizeEvidence(subject, {
      search: async (query) => {
        const rendered = buildWebSearchQuery(query) || `"${subject.name}" employees`;
        if (await this.researchContext.shouldSkipQuery(contextKey, rendered)) {
          const cached = await this.researchContext.getSearchHits(contextKey, rendered);
          if (cached.length) {
            return cached.map((hit) => ({
              title: hit.title,
              url: hit.url,
              snippet: hit.snippet,
              source: hit.provider,
              retrievedAt: hit.retrievedAt,
            }));
          }
          return [];
        }
        const hits = await this.search.search(query);
        await this.researchContext.markQueryIssued(contextKey, rendered);
        await this.researchContext.recordSearchHits(contextKey, rendered, hits);
        return hits;
      },
      fetchPage: (url) => this.readPage(url, contextKey),
    });
    await this.persist(data.companyId, data.organizationId, assessment);
    this.researchContext.observeDuration(data.companyId, Date.now() - started);
    if (assessment.outcome === 'conflict') return 'CONFLICT';
    return assessment.outcome === 'value' ? 'FOUND' : 'NOT_FOUND';
  }

  private async loadSubject(organizationId: string, companyId: string): Promise<EmployeeSizeSubject | null> {
    const [row] = await this.db.select({
      name: companies.name,
      website: companies.website,
      description: companies.description,
      city: companyLocations.city,
      state: companyLocations.state,
    }).from(companies)
      .leftJoin(companyLocations, and(eq(companyLocations.companyId, companies.id), eq(companyLocations.isPrimary, true)))
      .where(and(eq(companies.id, companyId), eq(companies.organizationId, organizationId)))
      .limit(1);
    if (!row?.name) return null;
    return row;
  }

  private async readPage(url: string, contextKey: { organizationId: string; companyId: string; searchExecutionId: string | null }): Promise<EmployeeSizePage | null> {
    try {
      const reused = await this.researchContext.getPages(contextKey);
      const match = reused.find((page) => (page.finalUrl || page.url).replace(/\/$/, '') === url.replace(/\/$/, ''));
      if (match?.content) {
        const text = visibleText(match.content);
        if (text) return { url: match.finalUrl || match.url, title: match.title ?? '', text };
      }
      const page = await this.fetch.fetchPage(url, { retries: 0 });
      const text = visibleText(page.body);
      if (!text) return null;
      await this.researchContext.mergePages(contextKey, [{
        url: page.url,
        finalUrl: page.finalUrl || page.url,
        content: page.body,
        title: page.title ?? null,
      }], 'employee_size');
      return { url: page.finalUrl || page.url, title: page.title ?? '', text };
    } catch {
      return null;
    }
  }

  private async persist(companyId: string, organizationId: string, assessment: EmployeeSizeAssessment) {
    await this.db.delete(leadEvidence).where(and(eq(leadEvidence.companyId, companyId), eq(leadEvidence.evidenceType, 'EMPLOYEE_SIZE')));
    await this.db.delete(verificationConflicts).where(and(
      eq(verificationConflicts.companyId, companyId),
      eq(verificationConflicts.organizationId, organizationId),
      eq(verificationConflicts.fieldName, 'companySize'),
      eq(verificationConflicts.resolutionStatus, 'OPEN'),
    ));
    for (const finding of assessment.findings) {
      await this.insertEvidence(companyId, finding);
    }
    if (assessment.outcome === 'none') {
      await this.db.update(companies).set({
        employeeCount: null,
        employeeRange: null,
        updatedAt: new Date(),
      }).where(and(eq(companies.id, companyId), eq(companies.organizationId, organizationId)));
      return;
    }
    if (assessment.outcome === 'conflict' && assessment.conflict) {
      await this.insertConflict(companyId, organizationId, assessment.conflict);
      await this.db.update(companies).set({
        employeeCount: null,
        employeeRange: null,
        updatedAt: new Date(),
      }).where(and(eq(companies.id, companyId), eq(companies.organizationId, organizationId)));
      return;
    }
    await this.db.update(companies).set({
      employeeCount: assessment.employeeCount,
      employeeRange: assessment.employeeRange,
      updatedAt: new Date(),
    }).where(and(eq(companies.id, companyId), eq(companies.organizationId, organizationId)));
  }

  private async insertEvidence(companyId: string, finding: EmployeeSizeFinding) {
    const idempotencyKey = createHash('sha256').update(JSON.stringify({
      companyId,
      field: 'companySize',
      sourceUrl: finding.sourceUrl,
      value: finding.value?.normalized ?? null,
      excerpt: finding.excerpt,
    })).digest('hex');
    const [existing] = await this.db.select({ id: leadEvidence.id }).from(leadEvidence).where(eq(leadEvidence.idempotencyKey, idempotencyKey)).limit(1);
    if (existing) return;
    const evidence = toEmployeeSizeEvidence(companyId, finding);
    await this.db.insert(leadEvidence).values({
      companyId: evidence.companyId,
      evidenceType: evidence.evidenceType,
      sourceUrl: evidence.sourceUrl,
      sourceType: evidence.sourceType,
      provider: evidence.provider,
      evidenceText: evidence.evidenceText,
      evidenceTimestamp: new Date(evidence.retrievedAt),
      idempotencyKey,
      metadata: {
        field: 'companySize',
        value: evidence.value,
        sourceType: evidence.sourceType,
        sourceUrl: evidence.sourceUrl,
        retrievedAt: evidence.retrievedAt,
        evidenceExcerpt: evidence.evidenceText,
        verified: evidence.verified,
        verificationStatus: evidence.verificationStatus,
      },
    });
  }

  private async insertConflict(
    companyId: string,
    organizationId: string,
    conflict: NonNullable<EmployeeSizeAssessment['conflict']>,
  ) {
    const idempotencyKey = createHash('sha256').update(JSON.stringify({
      companyId,
      field: 'companySize',
      valueA: conflict.valueA,
      valueB: conflict.valueB,
      sourceUrlA: conflict.left.sourceUrl,
      sourceUrlB: conflict.right.sourceUrl,
    })).digest('hex');
    const [existing] = await this.db.select({ id: verificationConflicts.id }).from(verificationConflicts).where(and(
      eq(verificationConflicts.organizationId, organizationId),
      eq(verificationConflicts.idempotencyKey, idempotencyKey),
    )).limit(1);
    if (existing) return;
    await this.db.insert(verificationConflicts).values({
      organizationId,
      companyId,
      fieldName: 'companySize',
      valueA: conflict.valueA,
      valueB: conflict.valueB,
      sourceTypeA: conflict.left.sourceType,
      sourceUrlA: conflict.left.sourceUrl,
      retrievedAtA: new Date(conflict.left.retrievedAt),
      evidenceExcerptA: conflict.left.excerpt,
      sourceTypeB: conflict.right.sourceType,
      sourceUrlB: conflict.right.sourceUrl,
      retrievedAtB: new Date(conflict.right.retrievedAt),
      evidenceExcerptB: conflict.right.excerpt,
      status: 'CONFLICT',
      requiresReview: true,
      resolutionStatus: 'OPEN',
      idempotencyKey,
    });
  }
}
