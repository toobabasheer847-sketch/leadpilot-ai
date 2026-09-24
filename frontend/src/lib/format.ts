export function businessValue(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return 'Not Found';
  if (value === 'NOT_FOUND') return 'Not Found';
  return String(value);
}

export function formatWhen(value: string | null | undefined): string {
  if (!value) return 'Not available';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not available';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

export function locationLabel(location: { city?: string | null; state?: string | null; country?: string | null } | null | undefined): string {
  if (!location) return 'Not Found';
  const parts = [location.city, location.state, location.country].filter((part): part is string => Boolean(part));
  return parts.length ? parts.join(', ') : 'Not Found';
}

export function metricLabel(value: number | null | undefined): string {
  return typeof value === 'number' ? value.toLocaleString() : 'Not available';
}

export function listLabel(value: unknown): string {
  if (Array.isArray(value)) {
    const items = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
    return items.length ? items.join(', ') : 'Not Found';
  }
  if (typeof value === 'string' && value.trim()) return value === 'NOT_FOUND' ? 'Not Found' : value;
  return 'Not Found';
}

export function safeMessage(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.length > 180) return null;
  if (/postgres|redis:|api[_-]?key|database_url|secret|bearer |econn|at\s+\S+\s+\(/i.test(value)) return null;
  return value;
}
