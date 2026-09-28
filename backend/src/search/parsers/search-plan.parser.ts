import { Injectable } from '@nestjs/common';
import { RESULT_SAFETY_CAP } from '../search-plan.limits';
import { interpretPlace } from '../search-plan.places';
import { CompanySize, SearchLocation, SearchPlan } from '../types/search-plan.types';

const LEAD_PHRASES: Array<[RegExp, string, string?]> = [
  [/\bcommercial real estate investors?\b/i, 'commercial_real_estate_investor', 'real_estate'],
  [/\bland investors?\b/i, 'land_investor', 'real_estate'],
  [/\bcash home buyers?\b/i, 'cash_home_buyer', 'real_estate'],
  [/\bhouse flippers?\b/i, 'house_flipper', 'real_estate'],
  [/\bfix(?:\s|-)?and(?:\s|-)?flip\b/i, 'fix_and_flip', 'real_estate'],
  [/\bbuy(?:\s|-)?and(?:\s|-)?hold\b/i, 'buy_and_hold', 'real_estate'],
  [/\bbrrrr?\b/i, 'brrrr', 'real_estate'],
  [/\bproperty investors?\b/i, 'real_estate_investor', 'real_estate'],
  [/\breal estate investors?\b/i, 'real_estate_investor', 'real_estate'],
  [/\breal estate investment(?:\s+compan(?:y|ies)|\s+firms?)?\b/i, 'real_estate_investor', 'real_estate'],
];

const CONTACT_TITLES: Array<[string, string]> = [
  ['ceo', 'CEO'],
  ['founder', 'Founder'],
  ['co-founder', 'Co-Founder'],
  ['president', 'President'],
  ['owner', 'Owner'],
  ['managing director', 'Managing Director'],
  ['manager', 'Manager'],
];

const COMPANY_FIELDS = ['website', 'linkedin', 'facebook', 'instagram'];
const CONTACT_FIELDS = ['email', 'phone', 'linkedin', 'facebook', 'instagram'];
const VAGUE = new Set(['excellent', 'strong', 'good', 'best', 'top', 'great', 'reputable', 'reputation', 'reputations', 'quality', 'leading', 'premier', 'successful']);

@Injectable()
export class SearchPlanParser {
  parse(prompt: string): SearchPlan {
    const normalizedPrompt = prompt.trim().replace(/\s+/g, ' ');
    const criteriaPrompt = normalizedPrompt.replace(/\breal-estate\b/gi, 'real estate');
    const companySize = this.parseCompanySize(criteriaPrompt);
    let working = this.withoutSizeClause(criteriaPrompt);
    const exclusions = this.parseExclusions(working);
    working = this.withoutExclusions(working);
    const count = this.parseRequestedCount(working);
    working = this.withoutCountClause(working, count?.count);
    const located = this.takeLocations(working);
    working = located ? working.slice(0, located.index).trim() : working;
    const locations = located?.locations ?? this.countryFallback(criteriaPrompt);
    const { industry, leadTypes } = this.interpretSubject(working, criteriaPrompt);
    const companyFields = COMPANY_FIELDS.filter((field) => criteriaPrompt.toLowerCase().includes(field));
    const contactFields = CONTACT_FIELDS.filter((field) => criteriaPrompt.toLowerCase().includes(field));
    const titles = this.collectMatches(criteriaPrompt.toLowerCase(), CONTACT_TITLES);
    const requiredFields = this.parseRequiredFields(criteriaPrompt, companyFields, contactFields);
    const optionalFields = this.parseOptionalFields(criteriaPrompt, companyFields, contactFields, requiredFields);
    const minimumScore = this.parseMinimumScore(criteriaPrompt);
    const unresolvedCriteria = this.parseUnresolved(normalizedPrompt, industry, leadTypes, locations, companySize, count?.count);
    if (count?.capped) {
      unresolvedCriteria.push({
        text: String(count.requested),
        reason: `requested count was limited to the safety cap of ${RESULT_SAFETY_CAP}`,
      });
    }

    const searchIntent = this.describeIntent(count?.count, industry, leadTypes, locations, companySize);
    return {
      industry,
      leadTypes,
      locations,
      ...(companySize ? { companySize, employeeRange: companySize } : {}),
      companyFields,
      ...(titles.length || contactFields.length ? {
        contactRequirements: {
          titles,
          fields: ['name', ...contactFields],
        },
      } : {}),
      ...(requiredFields.length ? { requiredFields } : {}),
      ...(optionalFields.length ? { optionalFields } : {}),
      ...(titles.length ? { requiredRoles: titles } : {}),
      ...(minimumScore !== undefined ? { minimumScore } : {}),
      ...(count ? { requestedCount: count.count, maxResults: count.count, countIntent: count.intent } : {}),
      ...(exclusions.length ? { exclusions } : {}),
      searchIntent,
      unresolvedCriteria,
    };
  }

  private parseRequestedCount(prompt: string): { count: number; requested: number; intent: 'exact' | 'maximum' | 'minimum'; capped: boolean } | undefined {
    const qualified = [...prompt.matchAll(/\b(up to|at least|maximum of|maximum|max|limit of|limit|minimum of|minimum|min)\s+(\d{1,5})\b/gi)];
    const bare = [...prompt.matchAll(/\b(?:find|get|show|need|want|search(?:\s+for)?|looking\s+for)\s+(\d{1,5})\b/gi)];
    const noun = [...prompt.matchAll(/\b(\d{1,5})\s+(?:companies|company|leads|lead|agencies|agency|firms|firm|businesses|business|restaurants|restaurant)\b/gi)];
    type Hit = { index: number; count: number; intent: 'exact' | 'maximum' | 'minimum' };
    const hits: Hit[] = [
      ...qualified.map((match) => ({
        index: match.index ?? 0,
        count: Number(match[2]),
        intent: /at least|minimum|\bmin\b/i.test(match[1]) ? 'minimum' as const : 'maximum' as const,
      })),
      ...bare.map((match) => ({ index: match.index ?? 0, count: Number(match[1]), intent: 'exact' as const })),
      ...noun.map((match) => ({ index: match.index ?? 0, count: Number(match[1]), intent: 'exact' as const })),
    ].filter((hit) => Number.isInteger(hit.count) && hit.count >= 1);
    hits.sort((left, right) => left.index - right.index);
    const selected = hits[0];
    if (!selected) return undefined;
    return {
      count: Math.min(RESULT_SAFETY_CAP, selected.count),
      requested: selected.count,
      intent: selected.intent,
      capped: selected.count > RESULT_SAFETY_CAP,
    };
  }

  private withoutCountClause(prompt: string, count: number | undefined): string {
    if (count === undefined) return prompt;
    return prompt
      .replace(/\b(?:up to|at least|maximum of|maximum|max|limit of|limit|minimum of|minimum|min)\s+\d{1,5}\b/gi, ' ')
      .replace(new RegExp(`\\b${count}\\b`), ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private takeLocations(prompt: string): { index: number; locations: SearchLocation[] } | null {
    const pattern = /\bin\s+(.+?)(?=\s+(?:that|who|which|with|without)\b|$)/gi;
    let match: RegExpExecArray | null;
    let found: { index: number; text: string } | null = null;
    while ((match = pattern.exec(prompt))) {
      found = { index: match.index, text: match[1].trim() };
    }
    if (!found?.text) return null;
    const locations = found.text
      .split(/\s+and\s+/i)
      .map((part) => interpretPlace(part))
      .filter((location) => Boolean(location.country || location.state || location.city || location.region))
      .slice(0, 3);
    if (!locations.length) return null;
    return { index: found.index, locations };
  }

  private countryFallback(prompt: string): SearchLocation[] {
    if (/\b(united states|usa|u\.s\.a\.|u\.s\.)\b/i.test(prompt)) return [{ country: 'US' }];
    return [];
  }

  private interpretSubject(working: string, fullPrompt: string): { industry: string[]; leadTypes: string[] } {
    const industry: string[] = [];
    const leadTypes: string[] = [];
    for (const [pattern, leadType, impliedIndustry] of LEAD_PHRASES) {
      if (!pattern.test(fullPrompt)) continue;
      if (!leadTypes.includes(leadType)) leadTypes.push(leadType);
      if (impliedIndustry && !industry.includes(impliedIndustry)) industry.push(impliedIndustry);
    }
    let subject = working
      .replace(/^(?:please\s+)?(?:find|get|show(?:\s+me)?|search(?:\s+for)?|looking\s+for|i\s+need|we\s+need|need)\s+/i, '')
      .replace(/^\d+\s+/, '')
      .replace(/\b(companies|company|agencies|agency|firms|firm|businesses|business|leads|lead)\b/gi, ' ')
      .replace(/\b(that|who|which|are|is|their|with|plus|need|identify|the|a|an|or)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[?.!]+$/g, '');
    for (const [pattern] of LEAD_PHRASES) subject = subject.replace(pattern, ' ');
    subject = subject.replace(/\s+/g, ' ').trim();
    if (/\breal estate\b/i.test(subject) && !industry.includes('real_estate')) industry.push('real_estate');
    const words = subject.toLowerCase().split(/\s+/).filter((word) => word && !VAGUE.has(word) && word !== 'and');
    if (!industry.length && words.length && words.length <= 6) {
      const slug = slugIndustry(words.join(' '));
      if (slug) industry.push(slug);
    }
    return { industry, leadTypes };
  }

  private describeIntent(count: number | undefined, industry: string[], leadTypes: string[], locations: SearchLocation[], companySize?: CompanySize): string {
    const place = locations.map((location) => [location.city, location.state, location.region, location.country].filter(Boolean).join(', ')).filter(Boolean).join(' and ');
    const category = leadTypes[0]?.replace(/_/g, ' ') || industry[0]?.replace(/_/g, ' ') || 'companies';
    const size = companySize ? ` with ${companySize.min ?? ''}${companySize.min != null && companySize.max != null ? '-' : ''}${companySize.max ?? (companySize.min != null ? '+' : '')} employees` : '';
    return [`find`, count ? String(count) : undefined, category, place ? `in ${place}` : undefined].filter(Boolean).join(' ') + size;
  }

  private parseCompanySize(prompt: string): CompanySize | undefined {
    const range = prompt.match(/\b(?:company\s+size\s+)?(\d+)\s*(?:to|-|–)\s*(\d+)(?:\s*employees?)?\b/i);
    if (range && (/\bemployees?\b/i.test(prompt) || /\bcompany\s+size\b/i.test(prompt))) {
      const min = Number(range[1]);
      const max = Number(range[2]);
      if (Number.isInteger(min) && Number.isInteger(max) && min >= 0 && max >= min) return { min, max };
    }
    const lowerBound = prompt.match(/\b(\d+)\s*\+\s*employees?\b/i);
    if (lowerBound) {
      const min = Number(lowerBound[1]);
      if (Number.isInteger(min) && min >= 0) return { min };
    }
    return undefined;
  }

  private withoutSizeClause(prompt: string): string {
    return prompt
      .replace(/\b(?:with\s+)?(?:company\s+size\s+)?\d+\s*(?:to|-|–)\s*\d+\s*employees?\b/gi, ' ')
      .replace(/\bcompany\s+size\s+\d+\s*(?:to|-|–)\s*\d+\b/gi, ' ')
      .replace(/\b\d+\s*\+\s*employees?\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private parseExclusions(prompt: string): string[] {
    const matches = [...prompt.matchAll(/\b(?:excluding|except|but not|without)\s+([^.,;]+)/gi)];
    return [...new Set(matches.map((match) => match[1].trim()).filter((text) => text && !/^specifying\b/i.test(text)))];
  }

  private withoutExclusions(prompt: string): string {
    return prompt
      .replace(/\b(?:excluding|except|but not|without)\s+[^.,;]+/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private parseUnresolved(prompt: string, industry: string[], leadTypes: string[], locations: SearchLocation[], companySize?: CompanySize, requestedCount?: number) {
    const unresolvedCriteria = [];
    if (/actively buying distressed properties/i.test(prompt)) {
      unresolvedCriteria.push({
        text: 'actively buying distressed properties',
        reason: 'requires evidence-based source classification',
      });
    }
    if (!industry.length && !leadTypes.length && !locations.length && !companySize && requestedCount === undefined) {
      unresolvedCriteria.push({
        text: prompt,
        reason: 'no supported deterministic search criteria were recognized',
      });
    }
    return unresolvedCriteria;
  }

  private parseRequiredFields(prompt: string, companyFields: string[], contactFields: string[]) {
    const required = new Set<string>();
    const mentioned = [...companyFields, ...contactFields];
    for (const field of mentioned) {
      if (new RegExp(`\\b(only|must|require[sd]?|with verified|verified)\\b[^.]{0,40}\\b${this.escape(field)}\\b`, 'i').test(prompt)
        || new RegExp(`\\b${this.escape(field)}\\b[^.]{0,40}\\b(required|only|must|verified)\\b`, 'i').test(prompt)) {
        required.add(field);
      }
    }
    if (/\bonly leads with verified email\b|\bverified email(?:s)? only\b|\bmust have (?:a )?verified email\b/i.test(prompt)) {
      required.add('email');
    }
    if (/\b(require[sd]?|must have|with)\b[^.]{0,40}\b(website)\b/i.test(prompt)) required.add('website');
    return [...required];
  }

  private parseOptionalFields(prompt: string, companyFields: string[], contactFields: string[], requiredFields: string[]) {
    const optional = new Set<string>();
    for (const field of [...companyFields, ...contactFields]) {
      if (requiredFields.includes(field)) continue;
      if (new RegExp(`\\boptional\\b[^.]{0,30}\\b${this.escape(field)}\\b`, 'i').test(prompt)
        || new RegExp(`\\b${this.escape(field)}\\b[^.]{0,30}\\boptional\\b`, 'i').test(prompt)
        || prompt.toLowerCase().includes(field)) {
        optional.add(field);
      }
    }
    return [...optional];
  }

  private parseMinimumScore(prompt: string) {
    const match = prompt.match(/\b(?:minimum|min)\s+score\s*(?:of\s*)?(\d{1,3})\b/i);
    if (!match) return undefined;
    const value = Number(match[1]);
    return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : undefined;
  }

  private collectMatches(prompt: string, terms: Array<[string, string]>) {
    return [...new Set(terms.filter(([term]) => prompt.includes(term)).map(([, value]) => value))];
  }

  private escape(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}

function slugIndustry(phrase: string): string {
  const words = phrase.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  const last = words[words.length - 1];
  if (last.length > 4 && last.endsWith('s') && !last.endsWith('ss')) words[words.length - 1] = last.endsWith('ies') ? `${last.slice(0, -3)}y` : last.slice(0, -1);
  const slug = words.join('_').replace(/[^a-z0-9_]+/g, '').replace(/^_+|_+$/g, '');
  return slug.length >= 2 ? slug : '';
}
