import { Injectable } from '@nestjs/common';
import { SearchPlan } from '../types/search-plan.types';

const STATE_NAMES: Record<string, string> = {
  tx: 'Texas', texas: 'Texas',
  ca: 'California', california: 'California',
  fl: 'Florida', florida: 'Florida',
  ny: 'New York', 'new york': 'New York',
};

const INDUSTRIES: Array<[string, string]> = [
  ['real estate', 'real_estate'],
  ['construction', 'construction'],
  ['software', 'software'],
  ['marketing', 'marketing'],
  ['healthcare', 'healthcare'],
  ['legal', 'legal'],
  ['finance', 'finance'],
];

const LEAD_TYPES: Array<[string, string]> = [
  ['cash home buyer', 'cash_home_buyer'],
  ['real estate investment', 'real_estate_investor'],
  ['real estate investor', 'real_estate_investor'],
  ['house flipper', 'house_flipper'],
  ['fix and flip', 'fix_and_flip'],
  ['buy and hold', 'buy_and_hold'],
  ['brrr', 'brrrr'],
  ['commercial real estate investor', 'commercial_real_estate_investor'],
  ['land investor', 'land_investor'],
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

@Injectable()
export class SearchPlanParser {
  parse(prompt: string): SearchPlan {
    const normalizedPrompt = prompt.trim().replace(/\s+/g, ' ');
    const lowerPrompt = normalizedPrompt.toLowerCase();
    const industry = this.collectMatches(lowerPrompt, INDUSTRIES);
    const leadTypes = this.collectMatches(lowerPrompt, LEAD_TYPES);
    const locations = this.parseLocations(lowerPrompt);
    const companySize = this.parseCompanySize(lowerPrompt);
    const companyFields = COMPANY_FIELDS.filter((field) => lowerPrompt.includes(field));
    const contactFields = CONTACT_FIELDS.filter((field) => lowerPrompt.includes(field));
    const titles = this.collectMatches(lowerPrompt, CONTACT_TITLES);
    const requiredFields = this.parseRequiredFields(lowerPrompt, companyFields, contactFields);
    const optionalFields = this.parseOptionalFields(lowerPrompt, companyFields, contactFields, requiredFields);
    const minimumScore = this.parseMinimumScore(lowerPrompt);
    const maxResults = this.parseMaxResults(lowerPrompt);
    const unresolvedCriteria = this.parseUnresolved(normalizedPrompt, lowerPrompt, industry, leadTypes, locations, companySize);

    return {
      industry,
      leadTypes,
      locations,
      ...(companySize ? { companySize } : {}),
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
      ...(maxResults !== undefined ? { maxResults } : {}),
      unresolvedCriteria,
    };
  }

  private parseLocations(prompt: string) {
    const locations = Object.entries(STATE_NAMES)
      .filter(([term]) => new RegExp(`\\b${this.escape(term)}\\b`, 'i').test(prompt))
      .map(([, state]) => ({ country: 'US', state }));

    if (/\b(united states|usa|us)\b/i.test(prompt) && locations.length === 0) {
      return [{ country: 'US' }];
    }

    return [...new Map(locations.map((location) => [location.state, location])).values()];
  }

  private parseCompanySize(prompt: string) {
    const range = prompt.match(/\b(?:company\s+size\s+)?(\d+)\s*(?:to|-|–)\s*(\d+)(?:\s*employees?)?\b/i);
    if (range && (/\bemployees?\b/i.test(prompt) || /\bcompany\s+size\b/i.test(prompt))) {
      return { min: Number(range[1]), max: Number(range[2]) };
    }

    const upperBound = prompt.match(/\b(\d+)\s*\+\s*employees?\b/i);
    if (upperBound) {
      return { min: Number(upperBound[1]) };
    }

    if (/\b(small company|small business)\b/i.test(prompt)) {
      return { max: 50 };
    }

    return undefined;
  }

  private parseUnresolved(prompt: string, lowerPrompt: string, industry: string[], leadTypes: string[], locations: unknown[], companySize?: unknown) {
    const unresolvedCriteria = [];
    if (/actively buying distressed properties/i.test(prompt)) {
      unresolvedCriteria.push({
        text: 'actively buying distressed properties',
        reason: 'requires evidence-based source classification',
      });
    }
    if (!industry.length && !leadTypes.length && !locations.length && !companySize) {
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
        || prompt.includes(field)) {
        optional.add(field);
      }
    }
    return [...optional];
  }

  private parseMaxResults(prompt: string) {
    const match = prompt.match(/\b(?:up to|maximum of|maximum|max|limit of|limit)\s+(\d{1,3})\b/i);
    if (!match) return undefined;
    const value = Number(match[1]);
    if (!Number.isInteger(value) || value < 1) return undefined;
    return Math.min(100, value);
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
