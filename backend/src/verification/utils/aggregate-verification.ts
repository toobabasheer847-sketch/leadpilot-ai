/**
 * Truthful aggregate verification summary from field-level rows + metadata.
 * Never promotes deliverability-only or syntax-only email states to ownership/verified aggregate.
 */

export interface AggregateVerificationFieldInput {
  field: string;
  status: string;
  metadata?: Record<string, unknown> | null;
}

export interface AggregateVerificationFieldSummary {
  field: string;
  status: string;
  displayStatus: string;
  ownershipVerified: boolean;
  deliverabilityVerified: boolean;
}

export interface AggregateVerificationSummary {
  /** Conservative aggregate used for list badges / company.verificationStatus. */
  aggregateStatus: string;
  fields: AggregateVerificationFieldSummary[];
  flags: {
    needsReview: boolean;
    conflict: boolean;
    personOwnershipVerified: boolean;
    deliverabilityVerified: boolean;
    evidenceVerified: boolean;
    evidenceSupported: boolean;
  };
}

export function summarizeAggregateVerification(rows: AggregateVerificationFieldInput[]): AggregateVerificationSummary {
  const fields = rows.map((row) => {
    const metadata = row.metadata ?? null;
    const ownershipVerified = metadata?.ownershipVerified === true;
    const deliverabilityVerified = metadata?.deliverabilityVerified === true;
    return {
      field: row.field,
      status: row.status,
      displayStatus: displayStatusForField(row.field, row.status, metadata),
      ownershipVerified,
      deliverabilityVerified,
    };
  });

  const statuses = fields.map((item) => item.status.toUpperCase());
  const display = fields.map((item) => item.displayStatus.toUpperCase());
  const needsReview = statuses.some((status) => status === 'NEEDS_REVIEW' || status === 'CONFLICT')
    || display.some((status) => status === 'NEEDS_REVIEW' || status === 'CONFLICT');
  const conflict = statuses.some((status) => status === 'CONFLICT') || display.some((status) => status === 'CONFLICT');
  const personOwnershipVerified = fields.some((item) => item.ownershipVerified || item.displayStatus === 'PERSON_OWNERSHIP_VERIFIED');
  const deliverabilityVerified = fields.some((item) => item.deliverabilityVerified || item.displayStatus === 'DELIVERABILITY_VERIFIED');
  const evidenceVerified = display.some((status) => status === 'EVIDENCE_VERIFIED')
    || (statuses.some((status) => status === 'VERIFIED') && !deliverabilityOnlyRows(fields));
  const evidenceSupported = display.some((status) => status === 'SUPPORTED' || status === 'EVIDENCE_SUPPORTED')
    || statuses.some((status) => status === 'SUPPORTED');

  let aggregateStatus = 'UNVERIFIED';
  if (!fields.length || fields.every((item) => item.status.toUpperCase() === 'NOT_FOUND')) {
    aggregateStatus = 'NOT_FOUND';
  } else if (needsReview) {
    aggregateStatus = 'NEEDS_REVIEW';
  } else if (personOwnershipVerified && fields.every((item) => ['VERIFIED', 'SUPPORTED', 'PERSON_OWNERSHIP_VERIFIED', 'EVIDENCE_VERIFIED'].includes(item.displayStatus.toUpperCase()) || item.status.toUpperCase() === 'NOT_FOUND')) {
    // Ownership present does not mean every field is ownership-verified — stay partially truthful.
    aggregateStatus = evidenceSupported || evidenceVerified ? 'PARTIALLY_VERIFIED' : 'SUPPORTED';
  } else if (fields.every((item) => item.displayStatus === 'EVIDENCE_VERIFIED' || item.status.toUpperCase() === 'VERIFIED') && !deliverabilityOnlyRows(fields)) {
    aggregateStatus = 'VERIFIED';
  } else if (evidenceVerified || evidenceSupported || deliverabilityVerified || personOwnershipVerified) {
    aggregateStatus = 'PARTIALLY_VERIFIED';
  } else if (fields.some((item) => item.displayStatus === 'SYNTAX_VALID' || item.status.toUpperCase() === 'UNVERIFIED')) {
    aggregateStatus = 'UNVERIFIED';
  }

  return {
    aggregateStatus,
    fields,
    flags: {
      needsReview,
      conflict,
      personOwnershipVerified,
      deliverabilityVerified,
      evidenceVerified,
      evidenceSupported,
    },
  };
}

function deliverabilityOnlyRows(fields: AggregateVerificationFieldSummary[]): boolean {
  const emailRows = fields.filter((item) => /email/i.test(item.field));
  if (!emailRows.length) return false;
  return emailRows.every((item) => item.deliverabilityVerified && !item.ownershipVerified);
}

function displayStatusForField(field: string, status: string, metadata?: Record<string, unknown> | null): string {
  const upper = status.toUpperCase();
  if (/email/i.test(field)) {
    if (metadata?.ownershipVerified === true) return 'PERSON_OWNERSHIP_VERIFIED';
    if (metadata?.deliverabilityVerified === true) return 'DELIVERABILITY_VERIFIED';
    const kind = typeof metadata?.verificationKind === 'string' ? metadata.verificationKind : null;
    if (kind === 'ownership') return 'PERSON_OWNERSHIP_VERIFIED';
    if (kind === 'deliverability') return 'DELIVERABILITY_VERIFIED';
    if (kind === 'independent_evidence' || upper === 'VERIFIED') return 'EVIDENCE_VERIFIED';
    if (kind === 'evidence_supported' || upper === 'SUPPORTED') return 'SUPPORTED';
    if (kind === 'syntax') return 'SYNTAX_VALID';
  }
  if (upper === 'VERIFIED') return 'EVIDENCE_VERIFIED';
  if (upper === 'SUPPORTED') return 'SUPPORTED';
  return upper || 'NOT_FOUND';
}
