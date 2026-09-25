import { classifyOfficialWebsiteHost, evaluateOfficialWebsite } from './official-website.validator';
import type { WebSearchQuery } from './web-search.types';

export function buildWebSearchQuery(input: WebSearchQuery): string {
  const name = input.companyName?.trim();
  if (!name) return '';
  const place = [input.city, input.state, input.country].map((value) => value?.trim()).filter((value): value is string => Boolean(value));
  const category = input.category?.trim();
  return [`"${name}"`, ...place, ...(category ? [category] : [])].join(' ');
}

export function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isNonOfficialWebsiteHost(hostname: string): boolean {
  return classifyOfficialWebsiteHost(hostname) !== null;
}

export function pageSupportsCompany(input: {
  companyName?: string | null;
  title?: string | null;
  text?: string | null;
  city?: string | null;
  state?: string | null;
  url?: string | null;
  html?: string | null;
}): boolean {
  return companySupportScore(input) > 0;
}

export function companySupportScore(input: {
  companyName?: string | null;
  title?: string | null;
  text?: string | null;
  city?: string | null;
  state?: string | null;
  url?: string | null;
  html?: string | null;
}): number {
  return evaluateOfficialWebsite(input).score;
}
