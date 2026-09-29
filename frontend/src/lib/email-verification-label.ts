/** Map raw verification status + metadata to truthful email labels (never inflate to ownership). */
export function truthfulEmailVerificationStatus(
  status: string | null | undefined,
  metadata?: Record<string, unknown> | null,
): string {
  if (metadata?.ownershipVerified === true) return 'PERSON_OWNERSHIP_VERIFIED';
  if (metadata?.deliverabilityVerified === true) return 'DELIVERABILITY_VERIFIED';
  const kind = typeof metadata?.verificationKind === 'string' ? metadata.verificationKind : null;
  if (kind === 'ownership') return 'PERSON_OWNERSHIP_VERIFIED';
  if (kind === 'deliverability') return 'DELIVERABILITY_VERIFIED';
  if (kind === 'independent_evidence') return 'EVIDENCE_VERIFIED';
  if (kind === 'evidence_supported') return 'EVIDENCE_SUPPORTED';
  if (kind === 'syntax') return 'SYNTAX_VALID';
  const upper = (status ?? '').toUpperCase();
  if (upper === 'PERSON_OWNERSHIP_VERIFIED') return 'PERSON_OWNERSHIP_VERIFIED';
  if (upper === 'DELIVERABILITY_VERIFIED') return 'DELIVERABILITY_VERIFIED';
  if (upper === 'EVIDENCE_VERIFIED') return 'EVIDENCE_VERIFIED';
  if (upper === 'EVIDENCE_SUPPORTED' || upper === 'SUPPORTED') return 'EVIDENCE_SUPPORTED';
  if (upper === 'SYNTAX_VALID' || upper === 'SYNTAX') return 'SYNTAX_VALID';
  // Legacy contact-quality "VERIFIED" is independent evidence, never ownership by itself.
  if (upper === 'VERIFIED') return 'EVIDENCE_VERIFIED';
  if (upper === 'UNVERIFIED') return 'UNVERIFIED';
  if (upper === 'NOT_FOUND') return 'NOT_FOUND';
  if (upper === 'NEEDS_REVIEW' || upper === 'CONFLICT') return 'NEEDS_REVIEW';
  if (upper === 'INVALID') return 'INVALID';
  if (upper === 'FOUND') return 'FOUND';
  if (!status) return 'NOT_FOUND';
  return status;
}
