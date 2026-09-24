import { enforceEvidenceBackedDecision, parseClassificationResult } from './schemas/classification.schema';
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
    expect(() => parseClassificationResult({ ...qualified, positiveEvidence: 'not-an-array' })).toThrow('Invalid positive evidence');
  });

  it('normalizes only non-empty public evidence excerpts', () => {
    const evidence = normalizeEvidence([
      { id: 'evidence-1', evidenceType: 'COMPANY_WEBSITE', sourceUrl: 'https://example.test/about', evidenceText: ' We buy houses for cash. ', evidenceTimestamp: null, metadata: { title: 'About' } },
      { id: 'evidence-2', evidenceType: 'COMPANY_WEBSITE', sourceUrl: 'https://example.test/team', evidenceText: ' ', evidenceTimestamp: null, metadata: null },
    ]);
    expect(evidence).toEqual([expect.objectContaining({ evidenceId: 'evidence-1', excerpt: 'We buy houses for cash.', title: 'About' })]);
  });
});
