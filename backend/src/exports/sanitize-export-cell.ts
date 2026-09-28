/** Characters that Excel/LibreOffice treat as formula starters when leading a cell. */
const FORMULA_PREFIX = /^(?:=|\+|-|@|\t|\r)/;

/**
 * Escape formula-injection prefixes with a leading single quote.
 * Safe for both CSV and XLSX text cells.
 */
export function sanitizeExportCell(value: unknown, options?: { missing?: 'NOT_FOUND' | 'EMPTY'; dateStyle?: 'iso' | 'friendly' }): string {
  const missing = options?.missing ?? 'NOT_FOUND';
  if (value === null || value === undefined || value === '') return missing === 'EMPTY' ? '' : 'NOT_FOUND';
  if (value instanceof Date) return formatExportDate(value, options?.dateStyle ?? 'friendly');
  const text = typeof value === 'string'
    ? value
    : typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint'
      ? String(value)
      : JSON.stringify(value) ?? '';
  if (!text) return missing === 'EMPTY' ? '' : 'NOT_FOUND';
  if (FORMULA_PREFIX.test(text)) return `'${text}`;
  return text;
}

export function escapeCsvCell(value: string): string {
  const escaped = value.replace(/"/g, '""');
  return /[",\r\n]/.test(escaped) ? `"${escaped}"` : escaped;
}

function formatExportDate(value: Date, style: 'iso' | 'friendly'): string {
  if (Number.isNaN(value.getTime())) return '';
  if (style === 'iso') return value.toISOString();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())} ${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())} UTC`;
}
