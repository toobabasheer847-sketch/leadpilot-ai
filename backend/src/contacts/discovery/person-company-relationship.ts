import { isPersonProfileUrl } from '../../contacts/discovery/public-decision-maker';
import { registrableDomain, sameRegistrableDomain } from '../../verification/utils/source-independence';

export type RelationshipVerdict = 'STRONG' | 'SUPPORTED' | 'WEAK' | 'MISSING' | 'REJECTED' | 'AMBIGUOUS';

export interface RelationshipAssessment {
  verdict: RelationshipVerdict;
  reason: string;
  freshnessClaimed: false;
  excerpt: string | null;
  sourceUrl: string | null;
}

export interface RelationshipEvidenceItem {
  sourceUrl?: string | null;
  evidenceText?: string | null;
  evidenceExcerpt?: string | null;
  field?: string | null;
}

/**
 * Assess whether a person is actually associated with the target company.
 * Does not claim employment freshness (freshnessClaimed is always false).
 */
export function assessPersonCompanyRelationship(input: {
  personName: string | null | undefined;
  title?: string | null;
  companyName: string;
  companyWebsite?: string | null;
  companyRelationship?: string | null;
  evidence?: RelationshipEvidenceItem[];
  relationshipVerificationStatus?: string | null;
}): RelationshipAssessment {
  const personName = input.personName?.trim() ?? '';
  const companyName = input.companyName?.trim() ?? '';
  if (!personName || !companyName) {
    return { verdict: 'MISSING', reason: 'PERSON_OR_COMPANY_MISSING', freshnessClaimed: false, excerpt: null, sourceUrl: null };
  }

  const evidence = input.evidence ?? [];
  const wrongCompany = evidence.find((item) => {
    const text = `${item.evidenceText ?? ''} ${item.evidenceExcerpt ?? ''}`;
    return wrongCompanyAffiliation(text, personName, companyName);
  });
  if (wrongCompany) {
    return {
      verdict: 'REJECTED',
      reason: 'WRONG_COMPANY_AFFILIATION',
      freshnessClaimed: false,
      excerpt: (wrongCompany.evidenceText ?? wrongCompany.evidenceExcerpt ?? '').slice(0, 160) || null,
      sourceUrl: wrongCompany.sourceUrl ?? null,
    };
  }

  const strongHit = evidence.find((item) => {
    const text = `${item.evidenceText ?? ''} ${item.evidenceExcerpt ?? ''}`;
    const url = item.sourceUrl ?? '';
    return personMentioned(text, personName)
      && companyMentioned(text, companyName)
      && isCompanyOwnedSource(url, input.companyWebsite)
      && (hasAffiliationLanguage(text, personName, input.title ?? null, companyName) || isTeamLeadershipPath(url));
  });
  if (strongHit) {
    return {
      verdict: 'STRONG',
      reason: 'OFFICIAL_COMPANY_RELATIONSHIP_EVIDENCE',
      freshnessClaimed: false,
      excerpt: (strongHit.evidenceText ?? strongHit.evidenceExcerpt ?? '').slice(0, 160) || null,
      sourceUrl: strongHit.sourceUrl ?? null,
    };
  }

  const supportedHit = evidence.find((item) => {
    const text = `${item.evidenceText ?? ''} ${item.evidenceExcerpt ?? ''}`;
    const url = item.sourceUrl ?? '';
    if (!personMentioned(text, personName) || !companyMentioned(text, companyName)) return false;
    if (isPersonProfileUrl(url) && hasAffiliationLanguage(text, personName, input.title ?? null, companyName)) return true;
    if (hasAffiliationLanguage(text, personName, input.title ?? null, companyName) && isReputableBusinessProfile(url)) return true;
    return false;
  });
  if (supportedHit) {
    return {
      verdict: 'SUPPORTED',
      reason: 'SUPPORTED_RELATIONSHIP_EVIDENCE',
      freshnessClaimed: false,
      excerpt: (supportedHit.evidenceText ?? supportedHit.evidenceExcerpt ?? '').slice(0, 160) || null,
      sourceUrl: supportedHit.sourceUrl ?? null,
    };
  }

  if (input.relationshipVerificationStatus === 'VERIFIED' || input.relationshipVerificationStatus === 'SUPPORTED') {
    return {
      verdict: input.relationshipVerificationStatus === 'VERIFIED' ? 'STRONG' : 'SUPPORTED',
      reason: 'RELATIONSHIP_FIELD_VERIFIED',
      freshnessClaimed: false,
      excerpt: input.companyRelationship ?? input.personName ?? null,
      sourceUrl: null,
    };
  }

  if (input.companyRelationship?.trim()) {
    const rel = input.companyRelationship.trim();
    const associated = companyMentioned(rel, companyName) || /^(current|active|employee|executive)$/i.test(rel);
    if (associated) {
      // Stored relationship marker without verification evidence stays weak / reviewable.
      return {
        verdict: 'WEAK',
        reason: 'RELATIONSHIP_STRING_ONLY',
        freshnessClaimed: false,
        excerpt: rel,
        sourceUrl: null,
      };
    }
  }

  const weakHit = evidence.find((item) => {
    const text = `${item.evidenceText ?? ''} ${item.evidenceExcerpt ?? ''}`;
    return personMentioned(text, personName) && companyMentioned(text, companyName);
  });
  if (weakHit) {
    return {
      verdict: 'AMBIGUOUS',
      reason: 'WEAK_SNIPPET_ONLY',
      freshnessClaimed: false,
      excerpt: (weakHit.evidenceText ?? weakHit.evidenceExcerpt ?? '').slice(0, 160) || null,
      sourceUrl: weakHit.sourceUrl ?? null,
    };
  }

  return { verdict: 'MISSING', reason: 'NO_RELATIONSHIP_EVIDENCE', freshnessClaimed: false, excerpt: null, sourceUrl: null };
}

/** Discovery-time gate: reject weak random snippets that only co-mention a title. */
export function publicHitEstablishesRelationship(
  companyName: string,
  hit: { title: string; url: string; snippet: string },
  personName: string,
  title: string,
  companyWebsite?: string | null,
): boolean {
  const text = `${hit.title}. ${hit.snippet}`;
  if (wrongCompanyAffiliation(text, personName, companyName)) return false;
  if (isCompanyOwnedSource(hit.url, companyWebsite) && personMentioned(text, personName) && companyMentioned(text, companyName)) {
    return true;
  }
  if (isPersonProfileUrl(hit.url) && hasAffiliationLanguage(text, personName, title, companyName)) return true;
  if (hasAffiliationLanguage(text, personName, title, companyName) && isReputableBusinessProfile(hit.url)) return true;
  // Clear public affiliation language (Name, Title of Company) is enough for discovery;
  // verification still owns deliverability / ownership checks later.
  if (hasAffiliationLanguage(text, personName, title, companyName) && personMentioned(text, personName) && companyMentioned(text, companyName)) {
    return true;
  }
  return false;
}

export function hasAffiliationLanguage(
  text: string,
  personName: string,
  title: string | null,
  companyName: string,
): boolean {
  const body = text.replace(/\s+/g, ' ');
  const company = escapeRegExp(companyName.trim());
  const person = escapeRegExp(personName.trim());
  const role = title?.trim() ? escapeRegExp(title.trim()) : '(?:CEO|Founder|President|Owner|Director|Partner|Manager|[A-Za-z][A-Za-z\\s-]{1,40})';
  const patterns = [
    new RegExp(`${person}[,\\s]+(?:the\\s+)?${role}\\s+(?:of|at|for|with)\\s+${company}`, 'i'),
    new RegExp(`${person}\\s+is\\s+(?:the\\s+)?${role}\\s+(?:of|at|for|with)\\s+${company}`, 'i'),
    new RegExp(`${role}\\s+(?:of|at|for)\\s+${company}`, 'i'),
    new RegExp(`${person}[,\\s]+${role}[,\\s]+${company}`, 'i'),
  ];
  return patterns.some((pattern) => pattern.test(body));
}

function isCompanyOwnedSource(url: string, companyWebsite?: string | null): boolean {
  if (!url?.trim()) return false;
  if (companyWebsite && sameRegistrableDomain(url, companyWebsite)) return true;
  return isTeamLeadershipPath(url);
}

function isTeamLeadershipPath(url: string): boolean {
  try {
    const path = new URL(url.includes('://') ? url : `https://${url}`).pathname.toLowerCase();
    return /\/(team|about|leadership|people|staff|our-team|management|founders?)(\/|$)/i.test(path);
  } catch {
    return false;
  }
}

function isReputableBusinessProfile(url: string): boolean {
  const domain = registrableDomain(url);
  if (!domain) return false;
  return [
    'linkedin.com',
    'crunchbase.com',
    'bloomberg.com',
    'reuters.com',
    'sec.gov',
    'companieshouse.gov.uk',
  ].some((allowed) => domain === allowed || domain.endsWith(`.${allowed}`));
}

function personMentioned(text: string, personName: string): boolean {
  const parts = personName.toLowerCase().split(/\s+/).filter((part) => part.length >= 2);
  const body = text.toLowerCase();
  if (parts.length >= 2) return parts.every((part) => body.includes(part));
  return body.includes(personName.toLowerCase());
}

function companyMentioned(text: string, companyName: string): boolean {
  const body = text.toLowerCase();
  const name = companyName.trim().toLowerCase();
  if (name.length >= 3 && body.includes(name)) return true;
  const tokens = name.split(/[^a-z0-9]+/).filter((token) => token.length >= 4 && !['investments', 'investment', 'capital', 'group', 'partners', 'properties', 'company', 'holdings', 'inc', 'llc', 'ltd'].includes(token));
  return tokens.length > 0 && tokens.every((token) => body.includes(token));
}

function wrongCompanyAffiliation(text: string, personName: string, companyName: string): boolean {
  const window = personWindow(text, personName);
  const match = window.match(/\b(?:of|at|for)\s+([A-Z][\p{L}'’.-]+(?:\s+[A-Z][\p{L}'’.-]+){0,5})/u);
  if (!match) return false;
  const named = match[1].replace(/\b(Inc|LLC|Ltd|GmbH|Co)\b\.?/gi, '').trim();
  if (named.length < 3) return false;
  return !companyMentioned(named, companyName) && !companyMentioned(companyName, named);
}

function personWindow(text: string, personName: string): string {
  const lower = text.toLowerCase();
  const name = personName.toLowerCase();
  const at = lower.indexOf(name.split(/\s+/)[0] ?? name);
  if (at < 0) return text;
  return text.slice(Math.max(0, at - 80), Math.min(text.length, at + 200));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
