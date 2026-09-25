import { classificationResponseSchema, enforceEvidenceBackedDecision, parseClassificationResult, parseModelJson } from './schemas/classification.schema';
import { buildInvestorClassificationPrompt } from './prompts/investor-classification.prompt';
import { INVESTOR_TYPES } from './types/classification.types';
import { normalizeEvidence } from './utils/evidence-normalizer';

describe('AI classification safeguards', () => {
  const qualified = {
    decision: 'QUALIFIED',
    confidence: 0.91,
    category: 'REAL_ESTATE_INVESTOR',
    investorType: 'CASH_HOME_BUYER',
    reasons: ['The evidence explicitly describes cash home acquisition.'],
    positiveEvidence: [{ evidenceId: 'evidence-1', reason: 'Explicit acquisition language' }],
    negativeEvidence: [],
    missingEvidence: [],
    exclusionReason: null,
  };

  it('accepts valid structured output and preserves evidence references', () => {
    const result = parseClassificationResult(qualified);
    expect(result.decision).toBe('QUALIFIED');
    expect(enforceEvidenceBackedDecision(result, new Set(['evidence-1'])).decision).toBe('QUALIFIED');
  });

  it('overrides qualified output when the cited evidence does not exist', () => {
    const result = enforceEvidenceBackedDecision(parseClassificationResult(qualified), new Set());
    expect(result.decision).toBe('INSUFFICIENT_EVIDENCE');
    expect(result.positiveEvidence).toHaveLength(0);
  });

  it('rejects invalid confidence and malformed JSON values', () => {
    expect(() => parseClassificationResult({ ...qualified, confidence: 1.1 })).toThrow('Invalid classification confidence');
    expect(() => parseClassificationResult({ ...qualified, confidence: '90' })).toThrow('Invalid classification confidence');
    expect(() => parseClassificationResult({ ...qualified, positiveEvidence: 'not-an-array' })).toThrow('Invalid positive evidence');
    expect(() => parseClassificationResult({ ...qualified, positiveEvidence: ['The company buys houses'] })).toThrow('Invalid positive evidence');
    expect(() => parseModelJson('not json')).toThrow('malformed classification');
  });

  it('accepts evidence ids returned as strings and numeric confidence strings', () => {
    const result = parseClassificationResult({
      ...qualified,
      confidence: '0.8',
      positiveEvidence: ['evidence-1'],
      negativeEvidence: [{ id: 'evidence-2', reason: 'Opposite signal' }],
      companySizeVerification: 'not_found',
    });
    expect(result.confidence).toBe(0.8);
    expect(result.positiveEvidence).toEqual([{ evidenceId: 'evidence-1', reason: '' }]);
    expect(result.negativeEvidence).toEqual([{ evidenceId: 'evidence-2', reason: 'Opposite signal' }]);
    expect(result.companySizeVerification).toBe('NOT_FOUND');
    expect(enforceEvidenceBackedDecision(result, new Set(['evidence-1'])).decision).toBe('QUALIFIED');
    expect(enforceEvidenceBackedDecision(result, new Set()).decision).toBe('INSUFFICIENT_EVIDENCE');
  });

  it('reads a classification object wrapped in markdown or an extra key', () => {
    const wrapped = parseModelJson(`Here is the result:\n\`\`\`json\n${JSON.stringify({ classification: qualified })}\n\`\`\``);
    expect(parseClassificationResult(wrapped).decision).toBe('QUALIFIED');
  });

  it('normalizes canonical, case, space, and hyphen investor types', () => {
    expect(parseClassificationResult(qualified).investorType).toBe('CASH_HOME_BUYER');
    expect(parseClassificationResult({ ...qualified, investorType: 'cash_home_buyer' }).investorType).toBe('CASH_HOME_BUYER');
    expect(parseClassificationResult({ ...qualified, investorType: 'cash home buyer' }).investorType).toBe('CASH_HOME_BUYER');
    expect(parseClassificationResult({ ...qualified, investorType: 'cash-home-buyer' }).investorType).toBe('CASH_HOME_BUYER');
    expect(parseClassificationResult({ ...qualified, investorType: 'fix and flip investor' }).investorType).toBe('FIX_AND_FLIP');
  });

  it('maps a missing or null investor type to NOT_DETERMINED without choosing a strategy', () => {
    const withoutType = { ...qualified };
    delete (withoutType as { investorType?: string }).investorType;
    expect(parseClassificationResult(withoutType).investorType).toBe('NOT_DETERMINED');
    expect(parseClassificationResult({ ...qualified, investorType: null }).investorType).toBe('NOT_DETERMINED');
    expect(parseClassificationResult({ ...qualified, investorType: 'unknown' }).investorType).toBe('NOT_DETERMINED');
    expect(parseClassificationResult({ ...qualified, investorType: null }).investorType).not.toBe('CASH_HOME_BUYER');
  });

  it('rejects unrecognized investor types instead of creating a qualified lead', () => {
    expect(() => parseClassificationResult({ ...qualified, investorType: 'ESTATE_AGENT' })).toThrow('Invalid investor type');
    expect(() => parseClassificationResult({ ...qualified, investorType: 'WHOLESALER' })).toThrow('Invalid investor type');
    expect(() => parseClassificationResult({ ...qualified, investorType: 'BROKER' })).toThrow('Invalid investor type');
    expect(() => parseClassificationResult({ ...qualified, decision: 'QUALIFIED', investorType: 'not a real type' })).toThrow('Invalid investor type');
  });

  it('keeps the prompt and response schema on the same investor type enum', () => {
    const prompt = buildInvestorClassificationPrompt({
      company: { id: 'company-1', name: 'Example', description: null, website: null, category: null, investorType: null, investmentStrategy: null, employeeCount: null, employeeRange: null },
      criteria: { category: 'REAL_ESTATE_INVESTOR' },
      evidence: [],
    });
    for (const investorType of INVESTOR_TYPES) expect(prompt).toContain(investorType);
    expect(prompt).toContain('Do not return null');
    expect(classificationResponseSchema().properties.investorType.enum).toEqual([...INVESTOR_TYPES]);
  });

  it('rejects truncated JSON, unexpected shapes, and missing required fields', () => {
    expect(() => parseModelJson('{"decision":"QUALIFIED"')).toThrow('malformed classification');
    expect(() => parseModelJson('')).toThrow('empty classification');
    expect(() => parseClassificationResult([])).toThrow('Unexpected classification array');
    expect(() => parseClassificationResult({ category: 'REAL_ESTATE_INVESTOR' })).toThrow('Missing required field: decision');
    expect(() => parseClassificationResult({ ...qualified, reasons: undefined })).toThrow('Missing required field: reasons');
    expect(() => parseClassificationResult({ ...qualified, positiveEvidence: [{ evidenceId: 'bad id', reason: 'spaces' }] })).toThrow('Invalid positive evidence');
  });

  it('accepts a missing or null exclusion reason and the canonical unknown investor type', () => {
    const withoutExclusion = { ...qualified };
    delete (withoutExclusion as { exclusionReason?: string | null }).exclusionReason;
    expect(parseClassificationResult(withoutExclusion).exclusionReason).toBeNull();
    expect(parseClassificationResult({ ...qualified, exclusionReason: null, investorType: 'NOT_DETERMINED' })).toMatchObject({
      exclusionReason: null,
      investorType: 'NOT_DETERMINED',
    });
  });

  it('drops an unknown evidence id instead of treating it as support', () => {
    const result = parseClassificationResult({
      ...qualified,
      positiveEvidence: [{ evidenceId: 'unknown-evidence', reason: 'not supplied' }, { evidenceId: 'evidence-1', reason: 'supplied' }],
    });
    expect(enforceEvidenceBackedDecision(result, new Set(['evidence-1'])).positiveEvidence).toEqual([{ evidenceId: 'evidence-1', reason: 'supplied' }]);
    expect(enforceEvidenceBackedDecision(parseClassificationResult({ ...qualified, positiveEvidence: [{ evidenceId: 'unknown-evidence', reason: 'not supplied' }] }), new Set(['evidence-1'])).decision).toBe('INSUFFICIENT_EVIDENCE');
  });

  it('normalizes only non-empty public evidence excerpts', () => {
    const evidence = normalizeEvidence([
      { id: 'evidence-1', evidenceType: 'COMPANY_WEBSITE', sourceUrl: 'https://example.test/about', evidenceText: ' We buy houses for cash. ', evidenceTimestamp: null, metadata: { title: 'About' } },
      { id: 'evidence-2', evidenceType: 'COMPANY_WEBSITE', sourceUrl: 'https://example.test/team', evidenceText: ' ', evidenceTimestamp: null, metadata: null },
    ]);
    expect(evidence).toEqual([expect.objectContaining({ evidenceId: 'evidence-1', excerpt: 'We buy houses for cash.', title: 'About' })]);
  });
});
