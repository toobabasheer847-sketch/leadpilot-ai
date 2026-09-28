import { AUTO_DUPLICATE_THRESHOLD, FUZZY_REVIEW_MAX_SCORE, MATCH_WEIGHTS, REVIEW_THRESHOLD } from './match.config';
import type { MatchDecision, MatchSignal, NormalizedCompany, NormalizedContact } from '../types/deduplication.types';

function exactName(left: string, right: string): boolean {
  return Boolean(left && right && left === right);
}

function decide(
  entityType: 'COMPANY' | 'CONTACT',
  recordA: string,
  recordB: string,
  signals: MatchSignal[],
  options?: { conflict?: boolean; forceReview?: boolean; hardIdentity?: boolean },
): MatchDecision {
  if (options?.conflict) {
    return {
      entityType,
      recordA,
      recordB,
      matchType: 'CONFLICT',
      status: 'CONFLICT',
      confidence: 0.5,
      signals,
      reason: 'Strong identity signals conflict across records.',
      autoMergeEligible: false,
    };
  }

  const score = Math.min(100, signals.reduce((sum, signal) => sum + (signal.matched ? signal.weight : 0), 0));
  const matched = signals.filter((signal) => signal.matched);
  const hardIdentity = Boolean(options?.hardIdentity) || matched.some((signal) => ['DOMAIN', 'PLACE_ID', 'EXTERNAL_ID', 'VERIFIED_EMAIL', 'VERIFIED_PHONE', 'LINKEDIN', 'NAME_TITLE_COMPANY'].includes(signal.type));

  if (options?.forceReview) {
    const reviewScore = Math.min(Math.max(score, REVIEW_THRESHOLD), FUZZY_REVIEW_MAX_SCORE);
    return {
      entityType,
      recordA,
      recordB,
      matchType: 'POTENTIAL_DUPLICATE',
      status: 'NEEDS_REVIEW',
      confidence: Number((reviewScore / 100).toFixed(4)),
      signals,
      reason: matched.length
        ? `Ambiguous match on ${matched.map((signal) => signal.type).join(', ')}; manual review required.`
        : 'Ambiguous identity signals require review.',
      autoMergeEligible: false,
    };
  }

  if (score >= AUTO_DUPLICATE_THRESHOLD && hardIdentity) {
    return {
      entityType,
      recordA,
      recordB,
      matchType: matched.some((signal) => signal.weight >= 50) ? 'EXACT_MATCH' : 'STRONG_MATCH',
      status: 'AUTO_DUPLICATE',
      confidence: Number((score / 100).toFixed(4)),
      signals,
      reason: `Matched ${matched.map((signal) => signal.type).join(', ')}.`,
      autoMergeEligible: true,
    };
  }

  if (score >= REVIEW_THRESHOLD) {
    return {
      entityType,
      recordA,
      recordB,
      matchType: hardIdentity ? 'POSSIBLE_MATCH' : 'POTENTIAL_DUPLICATE',
      status: 'NEEDS_REVIEW',
      confidence: Number((score / 100).toFixed(4)),
      signals,
      reason: `Possible match on ${matched.map((signal) => signal.type).join(', ')}; not auto-merged.`,
      autoMergeEligible: false,
    };
  }

  return {
    entityType,
    recordA,
    recordB,
    matchType: 'NO_MATCH',
    status: 'PENDING',
    confidence: Number((score / 100).toFixed(4)),
    signals,
    reason: matched.length ? `Insufficient identity signals (${matched.map((signal) => signal.type).join(', ')}).` : 'No reliable identity signals matched.',
    autoMergeEligible: false,
  };
}

export function matchCompanies(a: NormalizedCompany, b: NormalizedCompany): MatchDecision {
  const sharedExternal = a.externalIds.some((id) => b.externalIds.includes(id));
  const domainMatch = Boolean(a.domain && b.domain && a.domain === b.domain);
  const placeMatch = Boolean(a.placeId && b.placeId && a.placeId === b.placeId);
  const verifiedPhone = Boolean(a.phone && b.phone && a.phone === b.phone && a.phoneVerified && b.phoneVerified);
  const verifiedEmail = Boolean(a.email && b.email && a.email === b.email && a.emailVerified && b.emailVerified);
  const unverifiedPhone = Boolean(a.phone && b.phone && a.phone === b.phone && !verifiedPhone);
  const nameExact = exactName(a.name, b.name);
  const sameLocation = Boolean(a.city && b.city && a.city === b.city && a.state && a.state === b.state);

  const signals: MatchSignal[] = [
    { type: 'EXTERNAL_ID', matched: sharedExternal, weight: MATCH_WEIGHTS.externalId },
    { type: 'PLACE_ID', matched: placeMatch, weight: MATCH_WEIGHTS.placeId },
    { type: 'DOMAIN', matched: domainMatch, weight: MATCH_WEIGHTS.domain },
    { type: 'VERIFIED_PHONE', matched: verifiedPhone, weight: MATCH_WEIGHTS.verifiedPhone },
    { type: 'VERIFIED_EMAIL', matched: verifiedEmail, weight: MATCH_WEIGHTS.verifiedEmail },
    { type: 'PHONE', matched: unverifiedPhone, weight: MATCH_WEIGHTS.phone },
    { type: 'ADDRESS', matched: Boolean(a.address && b.address && a.address === b.address), weight: MATCH_WEIGHTS.address },
    { type: 'SOCIAL', matched: a.socialUrls.some((url) => b.socialUrls.includes(url)), weight: MATCH_WEIGHTS.social },
    { type: 'NAME', matched: nameExact, weight: MATCH_WEIGHTS.name },
    { type: 'LOCATION', matched: sameLocation, weight: MATCH_WEIGHTS.location },
    { type: 'EMAIL_DOMAIN', matched: Boolean(a.emailDomain && b.emailDomain && a.emailDomain === b.emailDomain), weight: MATCH_WEIGHTS.emailDomain },
  ];

  const conflictingDomains = Boolean(a.domain && b.domain && a.domain !== b.domain && nameExact && sameLocation);
  if (conflictingDomains) {
    return decide('COMPANY', a.id, b.id, signals, { conflict: true });
  }

  const hardIdentity = sharedExternal || placeMatch || domainMatch || verifiedPhone || verifiedEmail;

  // Name + city/state alone is never an automatic merge.
  if (!hardIdentity && nameExact && sameLocation) {
    return decide('COMPANY', a.id, b.id, signals, { forceReview: true });
  }

  return decide('COMPANY', a.id, b.id, signals, { hardIdentity });
}

export function matchContacts(a: NormalizedContact, b: NormalizedContact): MatchDecision {
  const sameCompany = a.companyId === b.companyId;
  if (!sameCompany) {
    return {
      entityType: 'CONTACT',
      recordA: a.id,
      recordB: b.id,
      matchType: 'NO_MATCH',
      status: 'PENDING',
      confidence: 0,
      signals: [{ type: 'SAME_COMPANY', matched: false, weight: 0 }],
      reason: 'Contacts at different companies are not merged.',
      autoMergeEligible: false,
    };
  }

  const verifiedEmail = Boolean(a.email && b.email && a.email === b.email && a.emailVerified && b.emailVerified);
  const unverifiedEmail = Boolean(a.email && b.email && a.email === b.email && !verifiedEmail);
  const linkedinMatch = Boolean(a.linkedinUrl && b.linkedinUrl && a.linkedinUrl === b.linkedinUrl);
  const nameTitle = Boolean(a.name && b.name && a.name === b.name && a.title && b.title && a.title === b.title);
  const nameOnly = Boolean(a.name && b.name && a.name === b.name && !nameTitle);

  const signals: MatchSignal[] = [
    { type: 'VERIFIED_EMAIL', matched: verifiedEmail, weight: MATCH_WEIGHTS.contactVerifiedEmail },
    { type: 'EMAIL', matched: unverifiedEmail, weight: MATCH_WEIGHTS.contactEmail },
    { type: 'PHONE', matched: Boolean(a.phone && b.phone && a.phone === b.phone), weight: MATCH_WEIGHTS.contactPhone },
    { type: 'LINKEDIN', matched: linkedinMatch, weight: MATCH_WEIGHTS.contactLinkedIn },
    { type: 'SOCIAL', matched: a.socialUrls.some((url) => b.socialUrls.includes(url) && url !== a.linkedinUrl), weight: MATCH_WEIGHTS.contactSocial },
    { type: 'NAME_TITLE_COMPANY', matched: nameTitle, weight: MATCH_WEIGHTS.contactNameCompany + MATCH_WEIGHTS.title },
    { type: 'NAME_COMPANY', matched: nameOnly, weight: MATCH_WEIGHTS.contactNameCompany },
    { type: 'TITLE', matched: Boolean(a.title && b.title && a.title === b.title), weight: MATCH_WEIGHTS.title },
  ];

  const hardIdentity = verifiedEmail || linkedinMatch || nameTitle;
  if (!hardIdentity && (nameOnly || unverifiedEmail)) {
    return decide('CONTACT', a.id, b.id, signals, { forceReview: true });
  }
  return decide('CONTACT', a.id, b.id, signals, { hardIdentity });
}

/** Deterministic master election: prefer verified, evidence-rich, complete records. */
export function electMaster(candidates: Array<{
  id: string;
  verificationStatus?: string | null;
  evidenceCount?: number;
  contactCount?: number;
  fieldCompleteness?: number;
}>): string {
  if (!candidates.length) throw new Error('Cannot elect a master from an empty candidate set');
  const ranked = [...candidates].sort((left, right) => masterScore(right) - masterScore(left) || left.id.localeCompare(right.id));
  return ranked[0].id;
}

export function masterScore(candidate: {
  verificationStatus?: string | null;
  evidenceCount?: number;
  contactCount?: number;
  fieldCompleteness?: number;
}): number {
  const verification = candidate.verificationStatus === 'VERIFIED' ? 50
    : candidate.verificationStatus === 'PARTIALLY_VERIFIED' || candidate.verificationStatus === 'SUPPORTED' ? 25
      : candidate.verificationStatus === 'NEEDS_REVIEW' || candidate.verificationStatus === 'CONFLICT' ? -10
        : 0;
  return verification
    + (candidate.evidenceCount ?? 0) * 3
    + (candidate.contactCount ?? 0) * 2
    + (candidate.fieldCompleteness ?? 0) * 5;
}

/** Canonical pair ordering for idempotent lead_duplicates inserts. */
export function orderedPair(left: string, right: string): [string, string] {
  return left < right ? [left, right] : [right, left];
}
