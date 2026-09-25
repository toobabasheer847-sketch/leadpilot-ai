import { INVESTOR_TYPES, type InvestorType } from '../types/classification.types';

const canonicalTypes = new Set<string>(INVESTOR_TYPES);

const aliases: Record<string, InvestorType> = {
  COMMERCIAL_REAL_ESTATE_INVESTOR: 'COMMERCIAL_INVESTOR',
  RESIDENTIAL_REAL_ESTATE_INVESTOR: 'REAL_ESTATE_INVESTOR_OTHER',
  REAL_ESTATE_INVESTOR: 'REAL_ESTATE_INVESTOR_OTHER',
  OTHER_INVESTOR: 'REAL_ESTATE_INVESTOR_OTHER',
  OTHER_REAL_ESTATE_INVESTOR: 'REAL_ESTATE_INVESTOR_OTHER',
  MIXED: 'REAL_ESTATE_INVESTOR_OTHER',
  MIXED_INVESTMENT_STRATEGIES: 'REAL_ESTATE_INVESTOR_OTHER',
  MULTIPLE_INVESTMENT_STRATEGIES: 'REAL_ESTATE_INVESTOR_OTHER',
  MULTI_FAMILY_INVESTOR: 'MULTIFAMILY_INVESTOR',
  UNKNOWN: 'NOT_DETERMINED',
  NOT_FOUND: 'NOT_DETERMINED',
  NA: 'NOT_DETERMINED',
  N_A: 'NOT_DETERMINED',
  NONE: 'NOT_DETERMINED',
  NULL: 'NOT_DETERMINED',
};

export function normalizeInvestorType(value: unknown): InvestorType {
  if (value == null) return 'NOT_DETERMINED';
  if (typeof value !== 'string') throw new Error(`Invalid investor type: ${investorTypeToken(value)}`);
  const key = value.trim().toUpperCase().replace(/&/g, ' AND ').replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/_+/g, '_');
  if (!key) return 'NOT_DETERMINED';
  if (canonicalTypes.has(key)) return key as InvestorType;
  if (key.endsWith('_INVESTOR')) {
    const stem = key.slice(0, -'_INVESTOR'.length);
    if (canonicalTypes.has(stem)) return stem as InvestorType;
  }
  const alias = aliases[key];
  if (alias) return alias;
  throw new Error(`Invalid investor type: ${investorTypeToken(value)}`);
}

function investorTypeToken(value: unknown): string {
  if (value == null) return 'null';
  if (typeof value === 'string') return value.trim().slice(0, 80).replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]');
  if (Array.isArray(value)) return `array:${value.length}`;
  if (typeof value === 'object') return 'object';
  return typeof value;
}
