import { formatWhen, businessValue } from '../../lib/format';
import { StatusBadge } from '../feedback/States';

export function VerificationCard({ label, value, status, evidenceCount, verifiedAt }: {
  label: string;
  value: string | null;
  status: string | null;
  evidenceCount: number | null;
  verifiedAt: string | null;
}) {
  return (
    <article className="panel verification-card">
      <h3>{label}</h3>
      <p>{businessValue(value)}</p>
      <StatusBadge status={status} />
      <p className="muted">Evidence count {evidenceCount === null ? 'Not available' : evidenceCount}</p>
      <p className="muted">Last verified {formatWhen(verifiedAt)}</p>
    </article>
  );
}
