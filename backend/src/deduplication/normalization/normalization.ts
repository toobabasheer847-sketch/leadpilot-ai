import type { NormalizedCompany, NormalizedContact } from '../types/deduplication.types';

export const DEDUPLICATION_VERSION = 'v1';

export function normalizeText(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function normalizeCompanyName(value: string | null | undefined): string {
  return normalizeText(value).replace(/\b(l l c|llc|ltd|limited|inc|incorporated|corp|corporation)\b/g, '').replace(/\s+/g, ' ').trim();
}

export function normalizeDomain(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    return url.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

export function normalizePhone(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return digits || null;
}

export function normalizeEmail(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized || null;
}

export function normalizeSocialUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    url.protocol = 'https:';
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    url.search = '';
    url.hash = '';
    url.pathname = url.pathname.replace(/\/$/, '');
    return url.toString();
  } catch {
    return null;
  }
}

export function normalizeAddress(...parts: Array<string | null | undefined>): string | null {
  const value = normalizeText(parts.filter(Boolean).join(' '));
  return value || null;
}

export function normalizeCompany(input: {
  id: string; name: string; website?: string | null; phone?: string | null; googlePlaceId?: string | null;
  address?: string | null; city?: string | null; state?: string | null; email?: string | null; socialUrls?: string[];
}): NormalizedCompany {
  return {
    id: input.id,
    name: normalizeCompanyName(input.name),
    domain: normalizeDomain(input.website),
    phone: normalizePhone(input.phone),
    placeId: input.googlePlaceId?.trim() || null,
    address: normalizeAddress(input.address),
    city: normalizeText(input.city),
    state: normalizeText(input.state),
    emailDomain: normalizeEmail(input.email)?.split('@')[1] ?? null,
    socialUrls: (input.socialUrls ?? []).map(normalizeSocialUrl).filter((value): value is string => Boolean(value)),
  };
}

export function normalizeContact(input: { id: string; companyId: string; fullName?: string | null; firstName?: string | null; lastName?: string | null; email?: string | null; phone?: string | null; socialUrls?: string[]; title?: string | null }): NormalizedContact {
  return {
    id: input.id,
    companyId: input.companyId,
    name: normalizeText(input.fullName || `${input.firstName ?? ''} ${input.lastName ?? ''}`),
    email: normalizeEmail(input.email),
    phone: normalizePhone(input.phone),
    socialUrls: (input.socialUrls ?? []).map(normalizeSocialUrl).filter((value): value is string => Boolean(value)),
    title: normalizeText(input.title),
  };
}
