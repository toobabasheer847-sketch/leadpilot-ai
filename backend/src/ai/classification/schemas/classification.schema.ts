import type { ClassificationResult, EvidenceReference, InvestorType } from '../types/classification.types';

const decisions = new Set(['QUALIFIED', 'NOT_QUALIFIED', 'INSUFFICIENT_EVIDENCE']);
const investorTypes = new Set<InvestorType>([
  'CASH_HOME_BUYER', 'FIX_AND_FLIP', 'BUY_AND_HOLD', 'BRRRR', 'COMMERCIAL_INVESTOR',
  'LAND_INVESTOR', 'MULTIFAMILY_INVESTOR', 'REAL_ESTATE_INVESTOR_OTHER', 'NOT_DETERMINED',
]);

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isEvidenceReference(value: unknown): value is EvidenceReference {
  return typeof value === 'object' && value !== null
    && typeof (value as EvidenceReference).evidenceId === 'string'
    && typeof (value as EvidenceReference).reason === 'string';
}

export function parseClassificationResult(value: unknown): ClassificationResult {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid classification response');
  const result = value as Record<string, unknown>;
  if (typeof result.decision !== 'string' || !decisions.has(result.decision)) throw new Error('Invalid classification decision');
  if (typeof result.confidence !== 'number' || !Number.isFinite(result.confidence) || result.confidence < 0 || result.confidence > 1) throw new Error('Invalid classification confidence');
  if (typeof result.category !== 'string' || !result.category) throw new Error('Invalid classification category');
  if (typeof result.investorType !== 'string' || !investorTypes.has(result.investorType as InvestorType)) throw new Error('Invalid investor type');
  if (!isStringArray(result.reasons) || !Array.isArray(result.positiveEvidence) || !result.positiveEvidence.every(isEvidenceReference)) throw new Error('Invalid positive evidence');
  if (!Array.isArray(result.negativeEvidence) || !result.negativeEvidence.every(isEvidenceReference)) throw new Error('Invalid negative evidence');
  if (!isStringArray(result.missingEvidence)) throw new Error('Invalid missing evidence');
  if (result.exclusionReason !== null && typeof result.exclusionReason !== 'string') throw new Error('Invalid exclusion reason');
  const companySizeVerification = result.companySizeVerification ?? 'NOT_FOUND';
  const locationStatus = result.locationStatus ?? 'NOT_FOUND';
  if (companySizeVerification !== 'FOUND' && companySizeVerification !== 'NOT_FOUND') throw new Error('Invalid company size verification');
  if (locationStatus !== 'FOUND' && locationStatus !== 'NOT_FOUND') throw new Error('Invalid location status');
  return { ...result, companySizeVerification, locationStatus } as unknown as ClassificationResult;
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
