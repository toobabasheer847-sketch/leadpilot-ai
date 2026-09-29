import type { CriterionEvidence, QualificationDecision } from '../types/qualification.types';

/**
 * Phase P — final data-quality gate.
 * Runs after criterion evaluation. Never invents fields.
 * Score cannot override a failed required criterion.
 * Unrequested missing fields never block QUALIFIED.
 */
export function applyFinalDataQualityGate(decision: QualificationDecision): QualificationDecision {
  const required = decision.criterionResults.filter((item) => item.required);
  const failed = required.filter((item) => item.result === 'NO_MATCH');
  const review = required.filter((item) => item.result === 'NEEDS_REVIEW' || item.result === 'NOT_FOUND');
  const optionalMissing = decision.criterionResults.filter((item) => !item.required && (item.result === 'NOT_FOUND' || item.result === 'NO_MATCH'));

  let status: QualificationDecision['status'] = 'QUALIFIED';
  if (failed.length) status = 'NOT_QUALIFIED';
  else if (review.length || decision.criterionResults.some((item) => item.criterion === 'conflicts' && item.result === 'NEEDS_REVIEW')) {
    status = 'NEEDS_REVIEW';
  }

  // Explicit Phase P rule: high score never resurrects a factual failure.
  if (status !== 'QUALIFIED' && decision.score != null && decision.score >= 90) {
    // Keep factual status; score remains informational only.
  }

  const disqualifiedReasons = failed.map((item) => item.message);
  const needsReviewReasons = review.map((item) => item.message);
  const qualifiedReasons = decision.criterionResults.filter((item) => item.result === 'MATCH').map((item) => item.message);
  const missingOptional = optionalMissing.map((item) => `${item.criterion}: ${item.message}`);

  return {
    ...decision,
    status,
    qualifiedReasons,
    disqualifiedReasons,
    needsReviewReasons,
    missingOptional,
  };
}

/** True when every required criterion MATCHED (used by tests / audit). */
export function allRequiredCriteriaMatched(results: CriterionEvidence[]): boolean {
  const required = results.filter((item) => item.required);
  return required.length > 0 && required.every((item) => item.result === 'MATCH');
}
