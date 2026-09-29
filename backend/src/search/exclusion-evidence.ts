/**
 * Evidence-based exclusion matching.
 * Uses light morphology + phrase presence — not a large hard-coded exclusion dictionary.
 * Clear matches reject; weak/partial overlaps stay ambiguous; silence is not an exclusion.
 */

export type ExclusionVerdict = 'EXCLUDED' | 'CLEAR' | 'AMBIGUOUS';

export interface ExclusionAssessment {
  verdict: ExclusionVerdict;
  exclusion: string;
  matchedTerm: string | null;
  excerpt: string | null;
  reason: string;
}

export function assessPlanExclusions(input: {
  exclusions: string[];
  text: string;
  companyName?: string | null;
  category?: string | null;
}): ExclusionAssessment[] {
  return (input.exclusions ?? [])
    .map((item) => item.trim())
    .filter(Boolean)
    .map((exclusion) => assessExclusion(exclusion, input.text, input.companyName, input.category));
}

export function assessExclusion(
  exclusion: string,
  text: string,
  companyName?: string | null,
  category?: string | null,
): ExclusionAssessment {
  const phrase = exclusion.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!phrase) {
    return { verdict: 'CLEAR', exclusion, matchedTerm: null, excerpt: null, reason: 'EMPTY_EXCLUSION' };
  }

  const corpus = `${text} ${category ?? ''}`.replace(/\s+/g, ' ').trim().toLowerCase();
  const name = (companyName ?? '').toLowerCase();
  const terms = expandExclusionTerms(phrase);

  // Multi-token exclusions (e.g. "hotel restaurants") require all significant tokens.
  const tokens = significantTokens(phrase);
  if (tokens.length >= 2) {
    const tokenHit = (haystack: string, token: string) => expandExclusionTerms(token).some((form) => wordPresent(haystack, form));
    const allInCorpus = tokens.every((token) => tokenHit(corpus, token));
    const allInNameOrCorpus = tokens.every((token) => tokenHit(corpus, token) || tokenHit(name, token));
    if (allInCorpus) {
      return {
        verdict: 'EXCLUDED',
        exclusion,
        matchedTerm: phrase,
        excerpt: excerptAround(corpus, tokens[0]),
        reason: 'EXCLUSION_PHRASE_MATCH',
      };
    }
    if (allInNameOrCorpus) {
      return {
        verdict: 'AMBIGUOUS',
        exclusion,
        matchedTerm: phrase,
        excerpt: companyName ?? null,
        reason: 'EXCLUSION_NAME_ONLY',
      };
    }
    const partial = tokens.filter((token) => tokenHit(corpus, token) || tokenHit(name, token));
    if (partial.length > 0 && partial.length < tokens.length) {
      return {
        verdict: 'AMBIGUOUS',
        exclusion,
        matchedTerm: partial.join(' '),
        excerpt: excerptAround(corpus, partial[0]) ?? companyName ?? null,
        reason: 'EXCLUSION_PARTIAL',
      };
    }
    return { verdict: 'CLEAR', exclusion, matchedTerm: null, excerpt: null, reason: 'EXCLUSION_NOT_FOUND' };
  }

  for (const term of terms) {
    if (wordPresent(corpus, term)) {
      return {
        verdict: 'EXCLUDED',
        exclusion,
        matchedTerm: term,
        excerpt: excerptAround(corpus, term),
        reason: 'EXCLUSION_TERM_MATCH',
      };
    }
  }

  // Name-only hits are ambiguous — do not fabricate a firm exclusion from a brand token.
  for (const term of terms) {
    if (term.length >= 4 && wordPresent(name, term)) {
      return {
        verdict: 'AMBIGUOUS',
        exclusion,
        matchedTerm: term,
        excerpt: companyName ?? null,
        reason: 'EXCLUSION_NAME_ONLY',
      };
    }
  }

  return { verdict: 'CLEAR', exclusion, matchedTerm: null, excerpt: null, reason: 'EXCLUSION_NOT_FOUND' };
}

function expandExclusionTerms(phrase: string): string[] {
  const base = phrase.trim().toLowerCase();
  const out = new Set<string>([base]);
  if (base.endsWith('ies') && base.length > 4) out.add(`${base.slice(0, -3)}y`);
  if (base.endsWith('es') && base.length > 4) out.add(base.slice(0, -2));
  if (base.endsWith('s') && !base.endsWith('ss') && base.length > 3) out.add(base.slice(0, -1));
  if (/\bbrokers?\b/.test(base)) {
    out.add('broker');
    out.add('brokers');
    out.add('brokerage');
  }
  if (/\bagenc(?:y|ies)\b/.test(base)) {
    out.add('agency');
    out.add('agencies');
  }
  if (/\brealtors?\b/.test(base)) {
    out.add('realtor');
    out.add('realtors');
  }
  return [...out];
}

function significantTokens(phrase: string): string[] {
  return phrase
    .split(/[^a-z0-9]+/i)
    .map((part) => part.toLowerCase())
    .filter((part) => part.length >= 3 && !STOP.has(part));
}

const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'only', 'not']);

function wordPresent(text: string, term: string): boolean {
  if (!text || !term) return false;
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`, 'i').test(text);
}

function excerptAround(text: string, term: string): string | null {
  const index = text.toLowerCase().indexOf(term.toLowerCase());
  if (index < 0) return null;
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + term.length + 40);
  return text.slice(start, end).trim();
}
