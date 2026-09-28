export type CategoryVerdict = 'MATCH' | 'NO_MATCH' | 'NEEDS_REVIEW';

export interface CategoryAssessment {
  verdict: CategoryVerdict;
  reason: string;
  excerpt: string | null;
}

interface ActivityGroup {
  id: string;
  phrases: string[];
  conflicts: string[];
}

/** Distinct business activities. A requested phrase does not match a conflicting activity. */
const ACTIVITIES: ActivityGroup[] = [
  {
    id: 'software',
    phrases: ['software', 'saas', 'software development', 'software company', 'developer tools', 'application development'],
    conflicts: ['computer repair', 'pc repair', 'it support', 'tech support', 'managed service provider', 'managed services', 'help desk', 'break fix'],
  },
  {
    id: 'marketing',
    phrases: ['marketing', 'marketing agency', 'advertising', 'advertising agency', 'digital marketing'],
    conflicts: ['print shop', 'sign shop'],
  },
  {
    id: 'restaurant',
    phrases: ['restaurant', 'restaurants', 'diner', 'eatery', 'cuisine'],
    conflicts: ['grocery', 'supermarket', 'food truck rental'],
  },
  {
    id: 'legal',
    phrases: ['legal', 'lawyer', 'attorney', 'law firm'],
    conflicts: [],
  },
  {
    id: 'healthcare',
    phrases: ['healthcare', 'health care', 'clinic', 'doctor', 'hospital', 'medical'],
    conflicts: [],
  },
  {
    id: 'finance',
    phrases: ['finance', 'financial', 'banking'],
    conflicts: [],
  },
  {
    id: 'construction',
    phrases: ['construction', 'construction company', 'general contractor', 'builder'],
    conflicts: ['hardware store', 'lumber yard'],
  },
  {
    id: 'real-estate',
    phrases: ['real estate', 'estate agent', 'realty', 'realtor'],
    conflicts: [],
  },
  {
    id: 'real-estate-investor',
    phrases: ['real estate investor', 'real estate investment', 'property investment', 'acquisition'],
    conflicts: ['real estate agent', 'realtor', 'brokerage', 'property management'],
  },
];

export function assessCategoryEvidence(input: {
  requested: string[];
  text: string;
  companyName?: string | null;
  taggedCategory?: string | null;
}): CategoryAssessment {
  const requested = input.requested.map((term) => term.replace(/_/g, ' ').trim().toLowerCase()).filter((term) => term.length > 2);
  if (!requested.length) {
    return { verdict: 'MATCH', reason: 'NO_CATEGORY_REQUESTED', excerpt: null };
  }
  const tagged = (input.taggedCategory ?? '').replace(/_/g, ' ').trim().toLowerCase();
  const body = stripName(`${input.text} ${tagged}`, input.companyName);
  const groups = ACTIVITIES.filter((group) => requested.some((term) => group.phrases.some((phrase) => phrase.includes(term) || term.includes(phrase))));
  const support = groups.length
    ? groups.some((group) => group.phrases.some((phrase) => body.includes(phrase)))
    : requested.some((term) => body.includes(term));
  const conflict = groups.some((group) => group.conflicts.some((phrase) => body.includes(phrase)));
  const excerpt = firstExcerpt(body, groups, requested);
  if (support && conflict) {
    return { verdict: 'NEEDS_REVIEW', reason: 'CATEGORY_AMBIGUOUS', excerpt };
  }
  if (support) {
    return { verdict: 'MATCH', reason: 'CATEGORY_EVIDENCE', excerpt };
  }
  if (conflict) {
    return { verdict: 'NO_MATCH', reason: 'CATEGORY_CONFLICT', excerpt };
  }
  const name = (input.companyName ?? '').toLowerCase();
  if (name && requested.some((term) => name.includes(term))) {
    return { verdict: 'NEEDS_REVIEW', reason: 'CATEGORY_NAME_ONLY', excerpt: input.companyName ?? null };
  }
  return { verdict: 'NO_MATCH', reason: 'CATEGORY_MISMATCH', excerpt };
}

function stripName(text: string, companyName?: string | null): string {
  const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();
  const name = companyName?.trim().toLowerCase();
  if (!name || name.length < 3) return normalized;
  return normalized.split(name).join(' ');
}

function firstExcerpt(body: string, groups: ActivityGroup[], requested: string[]): string | null {
  const phrases = groups.flatMap((group) => [...group.phrases, ...group.conflicts]);
  const needles = phrases.length ? phrases : requested;
  const hit = needles.find((phrase) => body.includes(phrase));
  if (!hit) return null;
  const at = body.indexOf(hit);
  return body.slice(Math.max(0, at - 40), Math.min(body.length, at + hit.length + 40)).trim();
}
