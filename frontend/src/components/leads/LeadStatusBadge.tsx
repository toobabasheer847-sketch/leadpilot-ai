import { StatusBadge } from '../feedback/States';

export function LeadStatusBadge({ status }: { status: string | null | undefined }) {
  return <StatusBadge status={status} />;
}
