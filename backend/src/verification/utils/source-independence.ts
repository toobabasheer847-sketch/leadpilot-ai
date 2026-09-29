/**
 * Shared evidence-independence helpers.
 * Independence is based on registrable domain identity — not URL path and not provider label alone.
 */

const MULTI_LABEL_PUBLIC_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'net.uk',
  'com.au', 'net.au', 'org.au', 'edu.au',
  'co.nz', 'org.nz', 'net.nz',
  'co.jp', 'or.jp', 'ne.jp',
  'co.kr', 'com.br', 'com.mx', 'com.ar',
  'co.in', 'com.sg', 'com.hk', 'com.tw',
  'co.za', 'org.za',
  'com.tr', 'com.ua',
]);

/** Registrable domain for a host or URL (example.com, example.co.uk). */
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
  const lastTwo = parts.slice(-2).join('.');
  if (MULTI_LABEL_PUBLIC_SUFFIXES.has(lastTwo) && parts.length >= 3) {
    return parts.slice(-3).join('.');
  }
  return lastTwo;
}

/**
 * Independent source identity keyed by registrable domain.
 * Same domain via different providers/paths counts as ONE source.
 * When no URL exists, fall back to a non-inflating provider key.
 */
export function independentSourceKey(input: {
  provider?: string | null;
  sourceType?: string | null;
  sourceUrl?: string | null;
  canonicalUrl?: string | null;
}): string {
  const domain = registrableDomain(input.canonicalUrl ?? input.sourceUrl);
  if (domain) return `domain:${domain}`;
  return `provider:${input.provider ?? input.sourceType ?? 'unknown'}`;
}

export function countIndependentSources(
  items: Array<{
    provider?: string | null;
    sourceType?: string | null;
    sourceUrl?: string | null;
    canonicalUrl?: string | null;
  }>,
): number {
  return new Set(items.map((item) => independentSourceKey(item))).size;
}

export function sameRegistrableDomain(left: string | null | undefined, right: string | null | undefined): boolean {
  const a = registrableDomain(left);
  const b = registrableDomain(right);
  return Boolean(a && b && a === b);
}
