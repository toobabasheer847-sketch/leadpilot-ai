import { classifyOfficialWebsiteHost } from '../../enrichment/website/official-website.validator';

/** Paths that indicate articles, directories, or aggregator listing pages — never company homes. */
const REJECTED_PATH = /\/(blog|blogs|directory|directories|guides?|guide|articles?|answers?|questions?|profiles?|agencies|companies|reviews?|rankings?)\b/i;

const EXTRA_DIRECTORY_HOSTS = [
  'homelight.com',
  'clutch.co',
  'goodfirms.co',
  'sortlist.com',
  'designrush.com',
  'quora.com',
];

export type DiscoveryUrlRejection =
  | 'INVALID_URL'
  | 'DIRECTORY'
  | 'REVIEW_SITE'
  | 'SOCIAL_PROFILE'
  | 'PROXY_OR_FILING'
  | 'NEWS_ARTICLE'
  | 'MARKETPLACE'
  | 'GENERIC_THIRD_PARTY_PAGE'
  | 'GENERIC_LIST';

/**
 * Hard gate used before persist (and by web assess): reject directory/blog/aggregator URLs.
 * Call this for both website and sourceUrl so Clutch/GoodFirms cannot enter the DB.
 */
export function rejectDiscoveryUrl(url: string | null | undefined): DiscoveryUrlRejection | null {
  if (!url?.trim()) return null;
  let parsed: URL;
  try {
    parsed = new URL(url.includes('://') ? url : `https://${url}`);
  } catch {
    return 'INVALID_URL';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'INVALID_URL';
  const hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (EXTRA_DIRECTORY_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`))) {
    if (hostname.includes('quora') || hostname.includes('homelight')) return 'GENERIC_THIRD_PARTY_PAGE';
    if (hostname.includes('clutch') || hostname.includes('goodfirms') || hostname.includes('sortlist') || hostname.includes('designrush')) {
      return 'REVIEW_SITE';
    }
    return 'DIRECTORY';
  }
  const hostReason = classifyOfficialWebsiteHost(hostname);
  if (hostReason && isDiscoveryHostRejection(hostReason)) return hostReason;
  if (REJECTED_PATH.test(parsed.pathname)) return 'GENERIC_LIST';
  return null;
}

const DISCOVERY_HOST_REJECTIONS = new Set<string>([
  'DIRECTORY',
  'REVIEW_SITE',
  'SOCIAL_PROFILE',
  'PROXY_OR_FILING',
  'NEWS_ARTICLE',
  'MARKETPLACE',
  'GENERIC_THIRD_PARTY_PAGE',
]);

function isDiscoveryHostRejection(reason: string): reason is DiscoveryUrlRejection {
  return DISCOVERY_HOST_REJECTIONS.has(reason);
}

export function isPersistableDiscoveryCandidate(input: {
  website?: string | null;
  sourceUrl?: string | null;
}): { ok: true } | { ok: false; reason: DiscoveryUrlRejection } {
  for (const url of [input.website, input.sourceUrl]) {
    const reason = rejectDiscoveryUrl(url);
    if (reason) return { ok: false, reason };
  }
  return { ok: true };
}
