export function formatCompanySize(status: string | null | undefined, value: string | number | null | undefined): string {
  if (status === 'NOT_REQUESTED' && (value == null || value === '')) return 'NOT_REQUESTED';
  if (status === 'CONFLICT' || value === 'CONFLICT') return 'CONFLICT';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string') {
    const text = value.trim();
    const span = text.match(/^(\d+)\s*[-–]\s*(\d+)$/);
    if (span) return `${span[1]}–${span[2]}`;
    if (/^\d+$/.test(text)) return text;
  }
  return 'UNKNOWN';
}
