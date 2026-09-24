import { AUTO_DUPLICATE_THRESHOLD, MATCH_WEIGHTS, REVIEW_THRESHOLD } from './match.config';
import type { MatchDecision, MatchSignal, NormalizedCompany, NormalizedContact } from '../types/deduplication.types';

function similarity(left: string, right: string): boolean {
  return left.length > 2 && right.length > 2 && (left === right || left.includes(right) || right.includes(left));
}

function decide(entityType: 'COMPANY' | 'CONTACT', recordA: string, recordB: string, signals: MatchSignal[], conflict = false): MatchDecision {
  if (conflict) return { entityType, recordA, recordB, matchType: 'CONFLICT', status: 'CONFLICT', confidence: 0.5, signals, reason: 'Strong identity signals conflict across records.' };
  const score = Math.min(100, signals.reduce((sum, signal) => sum + (signal.matched ? signal.weight : 0), 0));
  const matched = signals.filter((signal) => signal.matched);
  const matchType = score >= AUTO_DUPLICATE_THRESHOLD ? (matched.some((signal) => signal.weight >= 40) ? 'EXACT_MATCH' : 'STRONG_MATCH') : score >= REVIEW_THRESHOLD ? 'POSSIBLE_MATCH' : 'NO_MATCH';
  const status = score >= AUTO_DUPLICATE_THRESHOLD ? 'AUTO_DUPLICATE' : score >= REVIEW_THRESHOLD ? 'REVIEW_REQUIRED' : 'PENDING';
  return { entityType, recordA, recordB, matchType, status, confidence: Number((score / 100).toFixed(4)), signals, reason: matched.length ? `Matched ${matched.map((signal) => signal.type).join(', ')}.` : 'No reliable identity signals matched.' };
}

export function matchCompanies(a: NormalizedCompany, b: NormalizedCompany): MatchDecision {
  const signals: MatchSignal[] = [
    { type: 'DOMAIN', matched: Boolean(a.domain && b.domain && a.domain === b.domain), weight: MATCH_WEIGHTS.domain },
    { type: 'PHONE', matched: Boolean(a.phone && b.phone && a.phone === b.phone), weight: MATCH_WEIGHTS.phone },
    { type: 'PLACE_ID', matched: Boolean(a.placeId && b.placeId && a.placeId === b.placeId), weight: MATCH_WEIGHTS.placeId },
    { type: 'ADDRESS', matched: Boolean(a.address && b.address && a.address === b.address), weight: MATCH_WEIGHTS.address },
    { type: 'SOCIAL', matched: a.socialUrls.some((url) => b.socialUrls.includes(url)), weight: MATCH_WEIGHTS.social },
    { type: 'NAME', matched: similarity(a.name, b.name), weight: MATCH_WEIGHTS.name },
    { type: 'LOCATION', matched: Boolean(a.city && b.city && a.city === b.city && a.state && a.state === b.state), weight: MATCH_WEIGHTS.location },
    { type: 'EMAIL_DOMAIN', matched: Boolean(a.emailDomain && b.emailDomain && a.emailDomain === b.emailDomain), weight: MATCH_WEIGHTS.emailDomain },
  ];
  const conflictingDomains = Boolean(a.domain && b.domain && a.domain !== b.domain && similarity(a.name, b.name) && a.city === b.city && a.state === b.state);
  return decide('COMPANY', a.id, b.id, signals, conflictingDomains);
}

export function matchContacts(a: NormalizedContact, b: NormalizedContact): MatchDecision {
  const sameCompany = a.companyId === b.companyId;
  const signals: MatchSignal[] = [
    { type: 'EMAIL', matched: Boolean(a.email && b.email && a.email === b.email), weight: MATCH_WEIGHTS.contactEmail },
    { type: 'PHONE', matched: Boolean(a.phone && b.phone && a.phone === b.phone), weight: MATCH_WEIGHTS.contactPhone },
    { type: 'SOCIAL', matched: a.socialUrls.some((url) => b.socialUrls.includes(url)), weight: MATCH_WEIGHTS.contactSocial },
    { type: 'NAME_COMPANY', matched: sameCompany && Boolean(a.name && b.name && a.name === b.name), weight: MATCH_WEIGHTS.contactNameCompany },
    { type: 'TITLE', matched: sameCompany && Boolean(a.title && b.title && a.title === b.title), weight: MATCH_WEIGHTS.title },
  ];
  return decide('CONTACT', a.id, b.id, signals);
}
