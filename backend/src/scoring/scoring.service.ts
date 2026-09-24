import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, isNull, like } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { DRIZZLE } from '../database/database.constants';
import type { Database } from '../database/database.types';
import { auditLogs, companies, companyContacts, leadClassifications, leadEvidence, leadScores, leadVerifications } from '../database/schema/schema';
import { CONFLICT_PENALTY, SCORING_VERSION, SCORING_WEIGHTS } from './config/scoring.config';
import { ScoringQueue } from './scoring.queue';
import type { ScoreBand, ScoreBreakdown, ScoreSignal, ScoringJobData } from './types/scoring.types';

interface ScoreCompany {
  name: string;
  website: string | null;
  description: string | null;
  phone: string | null;
  employeeCount: number | null;
  employeeRange: string | null;
  investmentStrategy: string | null;
  marketsServed: unknown;
  propertyTypes: unknown;
}

interface ScoreContact {
  fullName: string | null;
  title: string | null;
  email: string | null;
  phone: string | null;
  linkedinUrl: string | null;
}

interface ScoreVerification {
  field: string;
  status: string;
  evidenceId: string | null;
}

interface ScoreEvidence {
  id: string;
  evidenceType: string;
  evidenceText: string;
  retrievedAt: Date | null;
}

interface ScoreClassification {
  decision: string;
}

export function scoreBand(score: number): ScoreBand {
  if (score < 40) return 'LOW';
  if (score < 70) return 'MEDIUM';
  if (score < 85) return 'HIGH';
  return 'VERY_HIGH';
}

export function calculateDeterministicScore(company: ScoreCompany, contact: ScoreContact | null, classification: ScoreClassification | null, verifications: ScoreVerification[], evidence: ScoreEvidence[]): ScoreBreakdown {
  const signals: ScoreSignal[] = [];
  const add = (name: string, value: string | number | boolean, points: number, reason: string, evidenceId?: string) => signals.push({ name, value, points, reason, ...(evidenceId ? { evidenceId } : {}) });
  const verification = (field: string) => verifications.find((item) => item.field === field);
  const statusPoints = (field: string, max: number, label: string) => {
    const item = verification(field);
    if (item?.status === 'VERIFIED') return { points: max, reason: `${label} is verified.`, evidenceId: item.evidenceId ?? undefined };
    if (item?.status === 'SUPPORTED') return { points: Math.ceil(max / 2), reason: `${label} is supported by evidence.`, evidenceId: item.evidenceId ?? undefined };
    if (item?.status === 'CONFLICT' || item?.status === 'INVALID') return { points: -Math.ceil(max / 2), reason: `${label} has conflicting or invalid verification evidence.`, evidenceId: item.evidenceId ?? undefined };
    return { points: 0, reason: `${label} is not verified; missing data is not penalized.` };
  };

  if (classification?.decision === 'QUALIFIED') add('investor_classification', classification.decision, SCORING_WEIGHTS.investorClassification, 'AI classification is QUALIFIED.');
  else if (classification?.decision === 'NOT_QUALIFIED') add('investor_classification', classification.decision, -SCORING_WEIGHTS.investorClassification, 'AI classification is NOT_QUALIFIED for the investor criteria.');
  else if (classification?.decision === 'INSUFFICIENT_EVIDENCE') add('investor_classification', classification.decision, 5, 'Classification lacks sufficient evidence and receives only a limited signal.');
  else add('investor_classification', 'NOT_AVAILABLE', 0, 'No classification is available.');

  const acquisition = evidence.find((item) => /buy|purchase|acqui|invest|cash home|fix.and.flip|rental/i.test(item.evidenceText));
  add('acquisition_evidence', Boolean(acquisition), acquisition ? SCORING_WEIGHTS.acquisitionEvidence : 0, acquisition ? 'Evidence contains explicit acquisition or investment language.' : 'No acquisition evidence was found.', acquisition?.id);

  for (const [field, signalName, weight, label] of [
    ['companyName', 'company_identity', SCORING_WEIGHTS.companyIdentity, 'Company identity'],
    ['website', 'official_website', SCORING_WEIGHTS.officialWebsite, 'Official website'],
    ['state', 'location', SCORING_WEIGHTS.location, 'Location'],
  ] as const) {
    const result = statusPoints(field, weight, label);
    add(signalName, verification(field)?.status ?? 'NOT_FOUND', result.points, result.reason, result.evidenceId);
  }

  if (contact) {
    const decisionMaker = statusPoints('fullName', SCORING_WEIGHTS.decisionMaker, 'Decision-maker');
    const title = statusPoints('title', SCORING_WEIGHTS.decisionMakerTitle, 'Decision-maker title');
    const profile = statusPoints('linkedin', SCORING_WEIGHTS.professionalProfile, 'Professional profile');
    const email = statusPoints('email', SCORING_WEIGHTS.businessEmail, 'Business email');
    const phone = statusPoints('phone', SCORING_WEIGHTS.businessPhone, 'Business phone');
    add('decision_maker', contact.fullName ?? 'NOT_FOUND', decisionMaker.points, decisionMaker.reason, decisionMaker.evidenceId);
    add('decision_maker_title', contact.title ?? 'NOT_FOUND', title.points, title.reason, title.evidenceId);
    add('professional_profile', contact.linkedinUrl ?? 'NOT_FOUND', profile.points, profile.reason, profile.evidenceId);
    add('business_email', contact.email ?? 'NOT_FOUND', email.points, email.reason, email.evidenceId);
    add('business_phone', contact.phone ?? 'NOT_FOUND', phone.points, phone.reason, phone.evidenceId);
  } else {
    add('decision_maker', false, 0, 'No decision-maker is available; missing data is not penalized.');
  }

  const companySize = statusPoints('companySize', SCORING_WEIGHTS.companySize, 'Company size');
  const strategy = statusPoints('investmentStrategy', SCORING_WEIGHTS.investmentStrategy, 'Investment strategy');
  const markets = statusPoints('marketsServed', SCORING_WEIGHTS.marketsServed, 'Markets served');
  const propertyType = statusPoints('propertyTypes', SCORING_WEIGHTS.propertyType, 'Property type');
  add('company_size', company.employeeCount ?? company.employeeRange ?? 'NOT_FOUND', companySize.points, companySize.reason, companySize.evidenceId);
  add('investment_strategy', company.investmentStrategy ?? 'NOT_FOUND', strategy.points, strategy.reason, strategy.evidenceId);
  add('markets_served', Boolean(company.marketsServed), markets.points, markets.reason, markets.evidenceId);
  add('property_type', Boolean(company.propertyTypes), propertyType.points, propertyType.reason, propertyType.evidenceId);

  const latestEvidence = evidence.filter((item) => item.retrievedAt).sort((a, b) => (b.retrievedAt?.getTime() ?? 0) - (a.retrievedAt?.getTime() ?? 0))[0];
  const ageDays = latestEvidence ? Math.max(0, (Date.now() - latestEvidence.retrievedAt!.getTime()) / 86400000) : null;
  const freshnessPoints = ageDays === null ? 0 : ageDays <= 30 ? SCORING_WEIGHTS.evidenceFreshness : ageDays <= 180 ? 2 : 1;
  add('evidence_freshness', ageDays === null ? 'NOT_AVAILABLE' : Math.round(ageDays), freshnessPoints, ageDays === null ? 'Evidence freshness is unavailable.' : `Latest evidence is ${Math.round(ageDays)} days old.`, latestEvidence?.id);

  const sourceTypes = [...new Set(evidence.map((item) => item.evidenceType))];
  add('source_diversity', sourceTypes.length, Math.min(SCORING_WEIGHTS.sourceDiversity, sourceTypes.length), `${sourceTypes.length} independent evidence source type(s) are available.`);

  const conflicts = verifications.filter((item) => item.status === 'CONFLICT' || item.status === 'INVALID').length;
  add('conflicting_evidence', conflicts, conflicts > 0 ? -CONFLICT_PENALTY : 0, conflicts > 0 ? `${conflicts} field(s) contain conflicting or invalid evidence.` : 'No conflicting verification evidence was found.');

  const expectedFields = 11;
  const availableFields = [company.name, company.website, company.description, company.phone, company.employeeCount ?? company.employeeRange, company.investmentStrategy, contact?.fullName, contact?.title, contact?.email, contact?.phone, contact?.linkedinUrl].filter(Boolean).length;
  const completenessPercentage = Math.round((availableFields / expectedFields) * 100);
  add('data_completeness', completenessPercentage, 0, `${availableFields} of ${expectedFields} important fields are available; completeness is reported separately from verification.`);

  const total = Math.max(0, Math.min(100, signals.reduce((sum, signal) => sum + signal.points, 0)));
  return { total, band: scoreBand(total), version: SCORING_VERSION, signals, availableFields, expectedFields, completenessPercentage, sourceTypes };
}

@Injectable()
export class ScoringService {
  constructor(@Inject(DRIZZLE) private readonly db: Database, private readonly queue: ScoringQueue) {}

  async enqueueCompany(companyId: string, organizationId: string, force = false, searchExecutionId: string | null = null) {
    await this.findCompany(companyId, organizationId);
    return this.enqueue(companyId, null, organizationId, force, searchExecutionId);
  }

  async enqueueContact(contactId: string, organizationId: string, force = false, searchExecutionId: string | null = null) {
    const contact = await this.findContact(contactId, organizationId);
    return this.enqueue(contact.companyId, contactId, organizationId, force, searchExecutionId);
  }

  async getCompany(companyId: string, organizationId: string) {
    await this.findCompany(companyId, organizationId);
    const [score] = await this.db.select().from(leadScores).where(and(eq(leadScores.companyId, companyId), eq(leadScores.organizationId, organizationId), isNull(leadScores.contactId))).orderBy(desc(leadScores.calculatedAt)).limit(1);
    return score ?? null;
  }

  async getContact(contactId: string, organizationId: string) {
    const contact = await this.findContact(contactId, organizationId);
    const [score] = await this.db.select().from(leadScores).where(and(eq(leadScores.contactId, contact.id), eq(leadScores.organizationId, organizationId))).orderBy(desc(leadScores.calculatedAt)).limit(1);
    return score ?? null;
  }

  scoreQueued(data: ScoringJobData) { return this.run(data); }

  private async enqueue(companyId: string, contactId: string | null, organizationId: string, force: boolean, searchExecutionId: string | null) {
    const base = this.key(organizationId, companyId, contactId, force ? Date.now().toString() : SCORING_VERSION);
    if (!force) {
      const [existing] = await this.db.select({ id: leadScores.id }).from(leadScores).where(and(eq(leadScores.organizationId, organizationId), like(leadScores.idempotencyKey, `${base}%`))).limit(1);
      if (existing) return { status: 'EXISTS' as const, scoreId: existing.id };
    }
    const job = await this.queue.enqueue({ companyId, contactId, organizationId, searchExecutionId, force, idempotencyKey: base });
    await this.audit(organizationId, companyId, 'LEAD_SCORING_STARTED', { jobId: job.id, contactId, version: SCORING_VERSION });
    return { status: 'QUEUED' as const, jobId: job.id };
  }

  private async run(data: ScoringJobData) {
    const company = await this.findCompany(data.companyId, data.organizationId);
    const contact = data.contactId ? await this.findContact(data.contactId, data.organizationId) : null;
    const [classification] = await this.db.select({ decision: leadClassifications.decision }).from(leadClassifications).where(and(eq(leadClassifications.companyId, company.id), eq(leadClassifications.organizationId, data.organizationId))).orderBy(desc(leadClassifications.createdAt)).limit(1);
    const verificationRows = await this.db.select({ field: leadVerifications.field, status: leadVerifications.status, evidenceId: leadVerifications.evidenceId }).from(leadVerifications).where(and(eq(leadVerifications.companyId, company.id), eq(leadVerifications.organizationId, data.organizationId), data.contactId ? eq(leadVerifications.contactId, data.contactId) : isNull(leadVerifications.contactId)));
    const evidenceRows = await this.db.select({ id: leadEvidence.id, evidenceType: leadEvidence.evidenceType, evidenceText: leadEvidence.evidenceText, retrievedAt: leadEvidence.evidenceTimestamp }).from(leadEvidence).where(eq(leadEvidence.companyId, company.id));
    const breakdown = calculateDeterministicScore(company, contact, classification ?? null, verificationRows, evidenceRows);
    const [stored] = await this.db.insert(leadScores).values({ companyId: company.id, contactId: data.contactId, organizationId: data.organizationId, searchExecutionId: data.searchExecutionId, score: breakdown.total, band: breakdown.band, version: SCORING_VERSION, breakdown, idempotencyKey: data.idempotencyKey }).returning();
    await this.audit(data.organizationId, company.id, 'LEAD_SCORING_COMPLETED', { scoreId: stored?.id, score: breakdown.total, band: breakdown.band, version: SCORING_VERSION, contactId: data.contactId });
    return stored;
  }

  private async findCompany(companyId: string, organizationId: string) {
    const [company] = await this.db.select().from(companies).where(and(eq(companies.id, companyId), eq(companies.organizationId, organizationId))).limit(1);
    if (!company) throw new NotFoundException('Company not found');
    return company;
  }

  private async findContact(contactId: string, organizationId: string) {
    const [row] = await this.db.select({ contact: companyContacts }).from(companyContacts).innerJoin(companies, eq(companies.id, companyContacts.companyId)).where(and(eq(companyContacts.id, contactId), eq(companies.organizationId, organizationId))).limit(1);
    if (!row) throw new NotFoundException('Contact not found');
    return row.contact;
  }

  private key(organizationId: string, companyId: string, contactId: string | null, version: string) { return createHash('sha256').update(JSON.stringify({ organizationId, companyId, contactId, version })).digest('hex'); }
  private audit(organizationId: string, entityId: string, action: string, metadata: unknown) { return this.db.insert(auditLogs).values({ organizationId, entityId, action, entityType: 'lead_score', metadata }); }
}
