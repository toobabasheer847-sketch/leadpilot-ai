import { CLASSIFICATION_DECISIONS, INVESTOR_TYPES, VERIFICATION_STATUSES, type ClassificationResult, type EvidenceReference } from '../types/classification.types';
import { normalizeInvestorType } from './investor-type';

const decisions = new Set<string>(CLASSIFICATION_DECISIONS);

const evidenceIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

const fieldLabels: Record<string, string> = {
  reasons: 'Invalid classification reasons',
  positiveEvidence: 'Invalid positive evidence',
  negativeEvidence: 'Invalid negative evidence',
  missingEvidence: 'Invalid missing evidence',
};

function stringList(value: unknown, field: string): string[] {
  if (value == null) throw new Error(`Missing required field: ${field}`);
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error(fieldLabels[field] ?? `Invalid classification ${field}`);
  return value as string[];
}

function asEvidenceReference(value: unknown): EvidenceReference | null {
  if (typeof value === 'string' && evidenceIdPattern.test(value.trim())) {
    return { evidenceId: value.trim(), reason: '' };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const evidenceId = typeof record.evidenceId === 'string'
    ? record.evidenceId.trim()
    : typeof record.id === 'string' ? record.id.trim() : '';
  if (!evidenceIdPattern.test(evidenceId)) return null;
  const reason = typeof record.reason === 'string' ? record.reason : '';
  return { evidenceId, reason };
}

function evidenceList(value: unknown, field: string): EvidenceReference[] {
  if (value == null) throw new Error(`Missing required field: ${field}`);
  if (!Array.isArray(value)) throw new Error(fieldLabels[field] ?? `Invalid classification ${field}`);
  return value.map((item) => {
    const reference = asEvidenceReference(item);
    if (!reference) throw new Error(fieldLabels[field] ?? `Invalid classification ${field}`);
    return reference;
  });
}

function confidenceValue(value: unknown): number {
  if (value == null) throw new Error('Missing required field: confidence');
  if (typeof value === 'string' && value.trim() === '') throw new Error('Invalid classification confidence');
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 1) throw new Error('Invalid classification confidence');
  return numeric;
}

function verificationStatus(value: unknown, label: string): 'FOUND' | 'NOT_FOUND' {
  if (value == null) return 'NOT_FOUND';
  if (typeof value !== 'string') throw new Error(label);
  const normalized = value.trim().toUpperCase();
  if (normalized === 'FOUND' || normalized === 'NOT_FOUND') return normalized;
  throw new Error(label);
}

export function parseModelJson(content: string): unknown {
  const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  if (!cleaned) throw new Error('OpenRouter returned an empty classification response');
  const parsed = readJson(cleaned) ?? readJson(jsonObjectSlice(cleaned));
  if (parsed === undefined) throw new Error('OpenRouter returned a malformed classification response');
  return unwrapClassification(parsed);
}

function readJson(value: string | null): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function jsonObjectSlice(value: string): string | null {
  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return value.slice(start, end + 1);
}

function unwrapClassification(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (typeof record.decision === 'string') return record;
  for (const key of ['classification', 'result']) {
    const nested = record[key];
    if (typeof nested === 'object' && nested !== null && typeof (nested as Record<string, unknown>).decision === 'string') return nested;
  }
  return record;
}

export function parseClassificationResult(value: unknown): ClassificationResult {
  if (Array.isArray(value)) throw new Error('Unexpected classification array');
  if (typeof value !== 'object' || value === null) throw new Error('Invalid classification response');
  const result = value as Record<string, unknown>;
  if (!('decision' in result) || result.decision == null) throw new Error('Missing required field: decision');
  if (typeof result.decision !== 'string' || !decisions.has(result.decision)) throw new Error('Invalid classification decision');
  if (!('category' in result) || result.category == null) throw new Error('Missing required field: category');
  if (typeof result.category !== 'string' || !result.category) throw new Error('Invalid classification category');
  const investorType = normalizeInvestorType(result.investorType);
  if (result.exclusionReason != null && typeof result.exclusionReason !== 'string') throw new Error('Invalid exclusion reason');
  return {
    decision: result.decision as ClassificationResult['decision'],
    confidence: confidenceValue(result.confidence),
    category: result.category,
    investorType,
    reasons: stringList(result.reasons, 'reasons'),
    positiveEvidence: evidenceList(result.positiveEvidence, 'positiveEvidence'),
    negativeEvidence: evidenceList(result.negativeEvidence, 'negativeEvidence'),
    missingEvidence: stringList(result.missingEvidence, 'missingEvidence'),
    exclusionReason: typeof result.exclusionReason === 'string' ? result.exclusionReason : null,
    companySizeVerification: verificationStatus(result.companySizeVerification, 'Invalid company size verification'),
    locationStatus: verificationStatus(result.locationStatus, 'Invalid location status'),
  };
}

const evidenceItemSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    evidenceId: { type: 'string' },
    reason: { type: 'string' },
  },
  required: ['evidenceId', 'reason'],
};

export function classificationResponseSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      decision: { type: 'string', enum: [...CLASSIFICATION_DECISIONS] },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      category: { type: 'string' },
      investorType: { type: 'string', enum: [...INVESTOR_TYPES] },
      reasons: { type: 'array', items: { type: 'string' } },
      positiveEvidence: { type: 'array', items: evidenceItemSchema },
      negativeEvidence: { type: 'array', items: evidenceItemSchema },
      missingEvidence: { type: 'array', items: { type: 'string' } },
      exclusionReason: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      companySizeVerification: { type: 'string', enum: [...VERIFICATION_STATUSES] },
      locationStatus: { type: 'string', enum: [...VERIFICATION_STATUSES] },
    },
    required: ['decision', 'confidence', 'category', 'investorType', 'reasons', 'positiveEvidence', 'negativeEvidence', 'missingEvidence', 'exclusionReason', 'companySizeVerification', 'locationStatus'],
  };
}

export function classificationResponseFormat() {
  return {
    type: 'json_schema',
    json_schema: {
      name: 'investor_classification',
      strict: true,
      schema: classificationResponseSchema(),
    },
  };
}

export function classificationParserCategory(error: unknown): 'EMPTY_RESPONSE' | 'INVALID_JSON' | 'INVALID_SCHEMA' | 'INVALID_ENUM' | 'MISSING_REQUIRED_FIELD' {
  const message = error instanceof Error ? error.message : '';
  if (/empty classification/i.test(message)) return 'EMPTY_RESPONSE';
  if (/malformed classification|invalid json/i.test(message)) return 'INVALID_JSON';
  if (/missing required field/i.test(message)) return 'MISSING_REQUIRED_FIELD';
  if (/invalid investor type|invalid classification decision/i.test(message)) return 'INVALID_ENUM';
  return 'INVALID_SCHEMA';
}

export function enforceEvidenceBackedDecision(result: ClassificationResult, evidenceIds: Set<string>): ClassificationResult {
  const validPositiveEvidence = result.positiveEvidence.filter((item) => evidenceIds.has(item.evidenceId));
  if (result.decision === 'QUALIFIED' && validPositiveEvidence.length === 0) {
    return {
      ...result,
      decision: 'INSUFFICIENT_EVIDENCE',
      positiveEvidence: [],
      missingEvidence: [...result.missingEvidence, 'Verified evidence supporting qualification'],
      exclusionReason: null,
      companySizeVerification: result.companySizeVerification,
      locationStatus: result.locationStatus,
    };
  }
  return { ...result, positiveEvidence: validPositiveEvidence };
}
