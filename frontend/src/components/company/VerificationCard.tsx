import { formatWhen, businessValue } from '../../lib/format';
import { StatusBadge } from '../feedback/States';

export function VerificationCard({
  label,
  value,
  status,
  evidenceCount,
  verifiedAt,
  metadata,
}: {
  label: string;
  value: string | null;
  status: string | null;
  evidenceCount: number | null;
  verifiedAt: string | null;
  metadata?: Record<string, unknown> | null;
}) {
  const kindHint = verificationKindHint(metadata);
  return (
    <article className="panel verification-card">
      <h3>{label}</h3>
      <p>{businessValue(value)}</p>
      <StatusBadge status={status} />
      {kindHint ? <p className="muted">{kindHint}</p> : null}
      <p className="muted">Evidence count {evidenceCount === null ? 'Not available' : evidenceCount}</p>
      <p className="muted">Last verified {formatWhen(verifiedAt)}</p>
    </article>
  );
}

function verificationKindHint(metadata?: Record<string, unknown> | null): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  if (metadata.ownershipVerified === true) return 'Ownership verified by evidence';
  if (metadata.deliverabilityVerified === true && metadata.ownershipVerified === false) return 'Deliverability verified; ownership not proven';
  if (metadata.verificationKind === 'syntax') return 'Syntax checked only';
  if (metadata.verificationKind === 'evidence_supported') return 'Supported by source evidence';
  if (metadata.hostValidated === true && metadata.ownershipVerified === false) return 'Host validated; ownership not proven';
  return null;
}
