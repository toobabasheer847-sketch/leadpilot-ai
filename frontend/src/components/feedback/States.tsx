import type { ReactNode } from 'react';

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}

export function EmptyState({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
  return (
    <div className="empty" role="status">
      <h2>{title}</h2>
      <p>{detail}</p>
      {action}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="error-state" role="alert">
      <p>{message}</p>
      {onRetry ? <button type="button" onClick={onRetry}>Try again</button> : null}
    </div>
  );
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="skeleton" aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => <span key={index} />)}
    </div>
  );
}

export function StatusBadge({ status }: { status: string | null | undefined }) {
  const label = verificationStatusLabel(status);
  const tone = label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return <span className={`badge badge-${tone}`}>{label}</span>;
}

/** Human-readable verification statuses without redesigning the badge UI. */
export function verificationStatusLabel(status: string | null | undefined): string {
  if (!status) return 'Not Found';
  switch (status.toUpperCase()) {
    case 'NOT_FOUND':
      return 'Not Found';
    case 'FOUND':
      return 'Found';
    case 'UNVERIFIED':
      return 'Unverified';
    case 'SYNTAX_VALID':
      return 'Email Syntax Valid';
    case 'SUPPORTED':
      return 'Evidence Supported';
    case 'EVIDENCE_VERIFIED':
      return 'Evidence Verified';
    case 'DELIVERABILITY_VERIFIED':
      return 'Deliverability Verified';
    case 'PERSON_OWNERSHIP_VERIFIED':
      return 'Person Ownership Verified';
    case 'VERIFIED':
      return 'Verified';
    case 'PARTIALLY_VERIFIED':
      return 'Partially Verified';
    case 'EVIDENCE_SUPPORTED':
      return 'Evidence Supported';
    case 'NEEDS_REVIEW':
      return 'Needs Review';
    case 'CONFLICT':
      return 'Conflict';
    case 'INVALID':
      return 'Invalid';
    case 'NOT_VERIFIED':
      return 'Unverified';
    case 'SKIPPED':
      return 'Skipped';
    case 'PENDING':
      return 'Pending';
    case 'RUNNING':
      return 'Running';
    case 'COMPLETED':
      return 'Completed';
    case 'PARTIAL':
      return 'Partial';
    case 'FAILED':
      return 'Failed';
    default:
      return status;
  }
}
