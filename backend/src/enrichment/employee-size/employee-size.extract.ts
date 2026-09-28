export type EmployeeSizeValue =
  | { kind: 'exact'; count: number; excerpt: string; normalized: string }
  | { kind: 'range'; min: number; max: number; excerpt: string; normalized: string };

export type EmployeeSizeExtraction = EmployeeSizeValue | { kind: 'unusable'; excerpt: string };

const RANGE_PATTERN = /\b(?:company size\s*:?\s*)?(\d{1,6})\s*(?:-|–|to)\s*(\d{1,6})\s+employees?\b/i;
const LABELED_RANGE_PATTERN = /\bcompany size\s*:?\s*(\d{1,6})\s*(?:-|–|to)\s*(\d{1,6})\b/i;
const LABELED_COUNT_PATTERN = /\b(?:employee count|number of employees|employees)\s*[:=]?\s*(\d{1,6})\b/gi;
const TRAILING_COUNT_PATTERN = /(?<![\d.])(\d{1,6})\s+employees?\b/gi;
const APPROXIMATE_PATTERN = /\b(?:approximately|approx\.?|about|around|roughly|nearly|over|under|at least|more than|fewer than|up to)\s+\d{1,6}\s+employees?\b/i;
const OPEN_ENDED_PATTERN = /\b\d{1,6}\+\s+employees?\b/i;
const QUALITATIVE_PATTERN = /\bsmall (?:company|business)\b/i;

export function extractEmployeeSize(text: string): EmployeeSizeExtraction | null {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  const range = LABELED_RANGE_PATTERN.exec(flat) ?? RANGE_PATTERN.exec(flat);
  if (range) {
    const min = Number(range[1]);
    const max = Number(range[2]);
    if (!usableCount(min) || !usableCount(max) || min > max) return null;
    if (hedgedPrefix(flat, range.index)) {
      return { kind: 'unusable', excerpt: excerptAround(flat, range.index, range[0].length) };
    }
    return { kind: 'range', min, max, excerpt: excerptAround(flat, range.index, range[0].length), normalized: `${min}-${max}` };
  }
  const labeled = firstExact(flat, LABELED_COUNT_PATTERN, true);
  if (labeled) return labeled;
  const trailing = firstExact(flat, TRAILING_COUNT_PATTERN, false);
  if (trailing) return trailing;
  const unusable = APPROXIMATE_PATTERN.exec(flat) ?? OPEN_ENDED_PATTERN.exec(flat) ?? QUALITATIVE_PATTERN.exec(flat);
  if (!unusable) return null;
  return { kind: 'unusable', excerpt: excerptAround(flat, unusable.index, unusable[0].length) };
}

function firstExact(text: string, pattern: RegExp, labeled: boolean): EmployeeSizeValue | null {
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    const count = Number(match[1]);
    if (!usableCount(count) || hedgedPrefix(text, match.index ?? 0)) continue;
    const after = text.slice((match.index ?? 0) + match[0].length);
    if (/^\s*(?:-|–|to)\s*\d/i.test(after)) continue;
    if (!labeled && /^\s+\d/.test(after)) continue;
    return { kind: 'exact', count, excerpt: excerptAround(text, match.index ?? 0, match[0].length), normalized: String(count) };
  }
  return null;
}

function hedgedPrefix(text: string, index: number): boolean {
  const prefix = text.slice(Math.max(0, index - 32), index);
  return /\b(?:approximately|approx\.?|about|around|roughly|nearly|over|under|at least|more than|fewer than|up to)\s*$/i.test(prefix) || /\d\s*\+\s*$/.test(prefix);
}

function usableCount(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 1_000_000;
}

function excerptAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 80);
  const end = Math.min(text.length, index + length + 80);
  return text.slice(start, end).trim();
}
