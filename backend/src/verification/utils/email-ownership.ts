import { isGenericBusinessEmail } from './generic-email';
import type { VerificationEvidence } from '../types/verification.types';

/** Lowest private-ish label of a host (example.com from a.b.example.com). */
export function registrableDomain(hostnameOrUrl: string | null | undefined): string | null {
  if (!hostnameOrUrl?.trim()) return null;
  let host = hostnameOrUrl.trim().toLowerCase();
  try {
    if (host.includes('://') || host.includes('/')) {
      host = new URL(host.includes('://') ? host : `https://${host}`).hostname;
    }
  } catch {
    return null;
  }
  host = host.replace(/^www\./, '');
  const parts = host.split('.').filter(Boolean);
  if (parts.length < 2) return host || null;
  // Keep last two labels; handles example.co.uk imperfectly but avoids path-based inflation.
  return parts.slice(-2).join('.');
}

/** Independent source identity: provider/sourceType + registrable domain (not path). */
export function independentSourceKey(input: {
  provider?: string | null;
  sourceType?: string | null;
  sourceUrl?: string | null;
  canonicalUrl?: string | null;
}): string {
  const domain = registrableDomain(input.canonicalUrl ?? input.sourceUrl) ?? (input.canonicalUrl ?? input.sourceUrl ?? 'unknown');
  return `${input.provider ?? input.sourceType ?? 'unknown'}|${domain}`;
}

export function excerptLinksPersonAndEmail(excerpt: string, email: string, personName: string | null | undefined): boolean {
  if (!excerpt?.trim() || !email?.trim()) return false;
  if (isGenericBusinessEmail(email)) return false;
  const text = excerpt.toLowerCase();
  if (!text.includes(email.toLowerCase())) return false;
  const name = personName?.trim();
  if (!name) return false;
  const parts = name.toLowerCase().split(/\s+/).filter((part) => part.length >= 2);
  if (parts.length < 2) return text.includes(parts[0] ?? name.toLowerCase());
  // Require first + last name co-occurrence with the email (same excerpt / window).
  return parts.every((part) => text.includes(part));
}

export interface PersonEmailOwnershipAssessment {
  ownershipVerified: boolean;
  ownershipSourceCount: number;
  verificationKind: 'syntax' | 'evidence_supported' | 'independent_evidence' | 'ownership' | 'deliverability';
}

/**
 * Person ownership requires ≥2 independent sources whose excerpts link the person name to the email.
 * Deliverability and domain match alone never set ownershipVerified.
 */
export function assessPersonEmailOwnership(input: {
  email: string | null | undefined;
  personName: string | null | undefined;
  evidence: VerificationEvidence[];
  evidenceStatus?: string | null;
  deliverabilityVerified?: boolean;
}): PersonEmailOwnershipAssessment {
  const email = input.email?.trim().toLowerCase() ?? '';
  if (!email || isGenericBusinessEmail(email)) {
    return {
      ownershipVerified: false,
      ownershipSourceCount: 0,
      verificationKind: input.deliverabilityVerified ? 'deliverability' : 'syntax',
    };
  }

  const supporting = input.evidence.filter((item) => {
    const metadata = typeof item.metadata === 'object' && item.metadata !== null ? item.metadata as Record<string, unknown> : {};
    const claimed = typeof metadata.value === 'string' && metadata.field === 'email' ? metadata.value.toLowerCase() : null;
    const hasEmail = claimed === email || item.evidenceText.toLowerCase().includes(email);
    if (!hasEmail) return false;
    return excerptLinksPersonAndEmail(item.evidenceText, email, input.personName);
  });

  const keys = new Set(supporting.map((item) => independentSourceKey(item)));
  const ownershipSourceCount = keys.size;
  if (ownershipSourceCount >= 2) {
    return { ownershipVerified: true, ownershipSourceCount, verificationKind: 'ownership' };
  }
  if (input.deliverabilityVerified) {
    return { ownershipVerified: false, ownershipSourceCount, verificationKind: 'deliverability' };
  }
  if (input.evidenceStatus === 'VERIFIED' || ownershipSourceCount >= 1 && input.evidenceStatus === 'SUPPORTED') {
    return {
      ownershipVerified: false,
      ownershipSourceCount,
      verificationKind: input.evidenceStatus === 'VERIFIED' ? 'independent_evidence' : 'evidence_supported',
    };
  }
  if (ownershipSourceCount === 1 || input.evidenceStatus === 'SUPPORTED') {
    return { ownershipVerified: false, ownershipSourceCount, verificationKind: 'evidence_supported' };
  }
  return { ownershipVerified: false, ownershipSourceCount, verificationKind: 'syntax' };
}
