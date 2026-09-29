import { formatWhen, businessValue } from '../../lib/format';
import { StatusBadge, verificationStatusLabel } from '../feedback/States';
import { truthfulEmailVerificationStatus } from '../../lib/email-verification-label';

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
  const isEmail = /email/i.test(label);
  const displayStatus = isEmail ? truthfulEmailVerificationStatus(status, metadata) : status;
  const kindHint = verificationKindHint(metadata, isEmail);
  return (
    <article className="panel verification-card">
      <h3>{label}</h3>
      <p>{businessValue(value)}</p>
      <StatusBadge status={displayStatus} />
      {kindHint ? <p className="muted">{kindHint}</p> : null}
      <p className="muted">Evidence count {evidenceCount === null ? 'Not available' : evidenceCount}</p>
      <p className="muted">Last verified {formatWhen(verifiedAt)}</p>
    </article>
  );
}

function verificationKindHint(metadata?: Record<string, unknown> | null, isEmail = false): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  if (metadata.ownershipVerified === true) return 'Person ownership verified by independent evidence';
  if (metadata.deliverabilityVerified === true && metadata.ownershipVerified === false) {
    return 'Deliverability verified; person ownership not proven';
  }
  if (metadata.verificationKind === 'syntax') return 'Email syntax valid only';
  if (metadata.verificationKind === 'evidence_supported') return 'Evidence supported; ownership not proven';
  if (metadata.verificationKind === 'independent_evidence') return 'Evidence verified across sources; ownership not proven';
  if (metadata.hostValidated === true && metadata.ownershipVerified === false) return 'Host validated; ownership not proven';
  if (isEmail && metadata.ownershipVerified === false) return verificationStatusLabel(truthfulEmailVerificationStatus(null, metadata));
  return null;
}
