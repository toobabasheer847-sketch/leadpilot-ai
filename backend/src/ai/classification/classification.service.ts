import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, desc, eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { DRIZZLE } from '../../database/database.constants';
import type { Database } from '../../database/database.types';
import { auditLogs, companies, leadClassifications, leadEvidence } from '../../database/schema/schema';
import { INVESTOR_PROMPT_VERSION } from './prompts/investor-classification.prompt';
import { enforceEvidenceBackedDecision, parseClassificationResult } from './schemas/classification.schema';
import type { LlmProvider } from './providers/llm-provider.interface';
import { LLM_PROVIDER } from './providers/llm-provider.interface';
import { normalizeEvidence } from './utils/evidence-normalizer';
import type { ClassificationCriteria, ClassificationInput } from './types/classification.types';
import type { ClassificationJobData } from './classification.queue';
import { ClassificationQueue } from './classification.queue';
import { UsageService } from '../../usage/usage.service';

const defaultCriteria: ClassificationCriteria = {
  category: 'REAL_ESTATE_INVESTOR',
  targetType: 'CASH_HOME_BUYER',
  requiredSignals: ['cash home buying', 'property acquisition'],
  excludedSignals: ['brokerage only', 'lending only'],
};

@Injectable()
export class ClassificationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    private readonly queue: ClassificationQueue,
    private readonly config: ConfigService,
    private readonly usage: UsageService,
  ) {}

  async enqueue(companyId: string, organizationId: string, criteria: ClassificationCriteria, searchExecutionId: string | null, force = false) {
    const company = await this.findCompany(companyId, organizationId);
    const idempotencyKey = this.buildIdempotencyKey(companyId, searchExecutionId, criteria);
    if (!force) {
      const [existing] = await this.db.select({ id: leadClassifications.id }).from(leadClassifications)
        .where(and(eq(leadClassifications.organizationId, organizationId), eq(leadClassifications.idempotencyKey, idempotencyKey)))
        .limit(1);
      if (existing) return { status: 'EXISTS' as const, classificationId: existing.id };
    }
    const job = await this.queue.enqueue({
      companyId: company.id,
      organizationId,
      searchExecutionId,
      criteria,
      idempotencyKey: force ? `${idempotencyKey}-${Date.now()}` : idempotencyKey,
    });
    await this.audit(organizationId, companyId, 'AI_CLASSIFICATION_STARTED', { jobId: job.id });
    return { status: 'QUEUED' as const, jobId: job.id };
  }

  classifyQueued(data: ClassificationJobData) {
    return this.runClassification(data);
  }

  async getLatest(companyId: string, organizationId: string) {
    await this.findCompany(companyId, organizationId);
    const [classification] = await this.db.select().from(leadClassifications)
      .where(and(eq(leadClassifications.companyId, companyId), eq(leadClassifications.organizationId, organizationId)))
      .orderBy(desc(leadClassifications.createdAt)).limit(1);
    return classification ?? null;
  }

  async getById(classificationId: string, organizationId: string) {
    const [classification] = await this.db.select().from(leadClassifications)
      .where(and(eq(leadClassifications.id, classificationId), eq(leadClassifications.organizationId, organizationId)))
      .limit(1);
    if (!classification) throw new NotFoundException('Classification not found');
    return classification;
  }

  async retry(companyId: string, organizationId: string, criteria: ClassificationCriteria, searchExecutionId: string | null) {
    await this.audit(organizationId, companyId, 'AI_CLASSIFICATION_RETRIED', null);
    return this.enqueue(companyId, organizationId, criteria, searchExecutionId, true);
  }

  private async runClassification(data: ClassificationJobData) {
    const company = await this.findCompany(data.companyId, data.organizationId);
    const evidenceRows = await this.db.select({
      id: leadEvidence.id,
      evidenceType: leadEvidence.evidenceType,
      sourceUrl: leadEvidence.sourceUrl,
      evidenceText: leadEvidence.evidenceText,
      evidenceTimestamp: leadEvidence.evidenceTimestamp,
      metadata: leadEvidence.metadata,
    }).from(leadEvidence)
      .where(eq(leadEvidence.companyId, company.id));
    const evidence = normalizeEvidence(evidenceRows);
    const input: ClassificationInput = {
      company: {
        id: company.id,
        name: company.name,
        description: company.description,
        website: company.website,
        category: company.category,
        investorType: company.investorType,
        investmentStrategy: company.investmentStrategy,
        employeeCount: company.employeeCount,
        employeeRange: company.employeeRange,
      },
      criteria: data.criteria,
      evidence,
    };
    try {
      await this.usage.checkRequestRate(data.organizationId, undefined, 'AI_CLASSIFICATION');
      await this.usage.assertDailyQuota(data.organizationId, 'AI_CLASSIFICATION');
      const result = enforceEvidenceBackedDecision(parseClassificationResult(await this.llm.classify(input)), new Set(evidence.map((item) => item.evidenceId)));
      const model = this.config.get<string>('openRouter.model') ?? 'unknown';
      const [stored] = await this.db.insert(leadClassifications).values({
        companyId: company.id,
        organizationId: data.organizationId,
        searchExecutionId: data.searchExecutionId,
        category: result.category,
        investorType: result.investorType,
        classification: result.category,
        decision: result.decision,
        confidence: result.confidence.toFixed(4),
        reasoning: result.reasons.join(' '),
        modelName: model,
        promptVersion: INVESTOR_PROMPT_VERSION,
        reasons: result.reasons,
        positiveEvidence: result.positiveEvidence,
        negativeEvidence: result.negativeEvidence,
        missingEvidence: result.missingEvidence,
        exclusionReason: result.exclusionReason,
        companySizeVerification: result.companySizeVerification,
        locationStatus: result.locationStatus,
        idempotencyKey: data.idempotencyKey,
        evidenceSummary: evidence.map((item) => `${item.evidenceId}: ${item.excerpt}`).join('\n').slice(0, 10000),
      }).returning();
      await this.audit(data.organizationId, company.id, 'AI_CLASSIFICATION_COMPLETED', { classificationId: stored?.id, decision: result.decision });
      await this.usage.recordUsage({ organizationId: data.organizationId, operation: 'AI_CLASSIFICATION', provider: 'openrouter', resourceType: 'company', resourceId: company.id, units: 1, status: 'COMPLETED', metadata: { model } });
      return stored;
    } catch (error) {
      await this.usage.recordUsage({ organizationId: data.organizationId, operation: 'AI_CLASSIFICATION', provider: 'openrouter', resourceType: 'company', resourceId: company.id, units: 1, status: 'FAILED', costStatus: 'UNKNOWN' });
      await this.audit(data.organizationId, company.id, 'AI_CLASSIFICATION_FAILED', { error: error instanceof Error ? error.message : 'Unknown classification error' });
      throw error;
    }
  }

  private async findCompany(companyId: string, organizationId: string) {
    const [company] = await this.db.select().from(companies)
      .where(and(eq(companies.id, companyId), eq(companies.organizationId, organizationId))).limit(1);
    if (!company) throw new NotFoundException('Company not found');
    return company;
  }

  private buildIdempotencyKey(companyId: string, searchExecutionId: string | null, criteria: ClassificationCriteria) {
    return createHash('sha256').update(JSON.stringify({ companyId, searchExecutionId, criteria, promptVersion: INVESTOR_PROMPT_VERSION })).digest('hex');
  }

  private audit(organizationId: string, entityId: string, action: string, metadata: unknown) {
    return this.db.insert(auditLogs).values({ organizationId, entityId, action, entityType: 'classification', metadata });
  }
}

export function mergeCriteria(criteria?: ClassificationCriteria): ClassificationCriteria {
  return { ...defaultCriteria, ...criteria };
}
