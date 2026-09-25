import { CLASSIFICATION_DECISIONS, INVESTOR_TYPES, VERIFICATION_STATUSES, type ClassificationInput } from '../types/classification.types';

export const INVESTOR_PROMPT_VERSION = 'investor-classifier-v4';

export function buildInvestorClassificationPrompt(input: ClassificationInput): string {
  return `You are an evidence-based business classification system.

Classify only from supplied evidence. Do not infer unsupported facts. Do not invent companies, people, URLs, emails, evidence, or evidence IDs. If evidence is insufficient, return INSUFFICIENT_EVIDENCE. Every QUALIFIED decision must cite supplied evidence IDs.

Return one JSON object and no markdown. The object must contain decision, confidence, category, investorType, reasons, positiveEvidence, negativeEvidence, missingEvidence, exclusionReason, companySizeVerification, and locationStatus.
decision must be exactly one of: ${CLASSIFICATION_DECISIONS.join(', ')}.
confidence must be a number from 0 to 1.
category is a short description of the supplied business. It is not an investor-type enum.
investorType must be exactly one of: ${INVESTOR_TYPES.join(', ')}.
Return that exact canonical investorType value. Do not invent enum values. Do not return a display label. When the evidence does not establish a specific investor type, return NOT_DETERMINED. Do not return null for investorType.
reasons and missingEvidence must be arrays of strings. Use an empty array when there are none.
positiveEvidence and negativeEvidence must be arrays of objects {"evidenceId":"<one supplied evidence id>","reason":"<short reason>"}. Copy evidence IDs exactly. Use an empty array when there are none.
exclusionReason must be a string when the company is excluded, and null when it is not.
companySizeVerification and locationStatus must be exactly one of: ${VERIFICATION_STATUSES.join(', ')}. Use NOT_FOUND when supplied company facts do not provide reliable size or location. Do not return null for those two fields.

User criteria:
${JSON.stringify(input.criteria)}

Company facts are context only and are not evidence by themselves:
${JSON.stringify(input.company)}

Supplied evidence, and only supplied evidence:
${JSON.stringify(input.evidence)}`;
}
