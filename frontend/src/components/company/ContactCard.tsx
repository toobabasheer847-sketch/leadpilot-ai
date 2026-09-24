import { StatusBadge } from '../feedback/States';
import { businessValue } from '../../lib/format';

export function ContactCard({ email, emailStatus, phone, phoneStatus }: {
  email: string | null;
  emailStatus: string | null;
  phone: string | null;
  phoneStatus: string | null;
}) {
  return (
    <div className="contact-quality">
      <div>
        <p className="muted">Email</p>
        <p>{businessValue(email)}</p>
        <StatusBadge status={emailStatus} />
      </div>
      <div>
        <p className="muted">Phone</p>
        <p>{businessValue(phone)}</p>
        <StatusBadge status={phoneStatus} />
      </div>
    </div>
  );
}
