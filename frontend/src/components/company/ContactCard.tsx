import { StatusBadge } from '../feedback/States';
import { businessValue } from '../../lib/format';
import { truthfulEmailVerificationStatus } from '../../lib/email-verification-label';

export function ContactCard({ email, emailStatus, phone, phoneStatus }: {
  email: string | null;
  emailStatus: string | null;
  phone: string | null;
  phoneStatus: string | null;
}) {
  const emailDisplay = truthfulEmailVerificationStatus(emailStatus);
  return (
    <div className="contact-quality">
      <div>
        <p className="muted">Email</p>
        <p>{businessValue(email)}</p>
        <StatusBadge status={emailDisplay} />
      </div>
      <div>
        <p className="muted">Phone</p>
        <p>{businessValue(phone)}</p>
        <StatusBadge status={phoneStatus} />
      </div>
    </div>
  );
}
