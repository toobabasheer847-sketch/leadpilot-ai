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

export function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="empty" role="status">
      <h2>{title}</h2>
      <p>{detail}</p>
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
  const label = !status ? 'Not Found' : status === 'NOT_FOUND' ? 'Not Found' : status;
  return <span className={`badge badge-${label.toLowerCase()}`}>{label}</span>;
}
