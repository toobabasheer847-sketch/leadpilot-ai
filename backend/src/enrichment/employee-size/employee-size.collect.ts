import { classifyOfficialWebsiteHost } from '../website/official-website.validator';
import { visibleText } from '../website/web-search.query';
import type { WebSearchQuery, WebSearchResult } from '../website/web-search.types';
import { extractEmployeeSize, type EmployeeSizeValue } from './employee-size.extract';
import { employeeSizePageMatchesCompany, sameSite, type EmployeeSizeSubject } from './employee-size.identity';

export type EmployeeSizeSourceType = 'official_company' | 'public_company_profile' | 'public_directory' | 'other_public';

export interface EmployeeSizeFinding {
  sourceUrl: string;
  sourceType: EmployeeSizeSourceType;
  excerpt: string;
  value: EmployeeSizeValue | null;
  verified: boolean;
  retrievedAt: string;
}

export interface EmployeeSizeAssessment {
  findings: EmployeeSizeFinding[];
  outcome: 'none' | 'value' | 'conflict';
  employeeCount: number | null;
  employeeRange: string | null;
  conflict: { valueA: string; valueB: string; left: EmployeeSizeFinding; right: EmployeeSizeFinding } | null;
}

export interface EmployeeSizePage {
  url: string;
  title: string;
  text: string;
}

export async function collectEmployeeSizeEvidence(
  company: EmployeeSizeSubject,
  deps: {
    search: (query: WebSearchQuery) => Promise<WebSearchResult[]>;
    fetchPage: (url: string) => Promise<EmployeeSizePage | null>;
  },
): Promise<EmployeeSizeAssessment> {
  const pages: EmployeeSizePage[] = [];
  const seen = new Set<string>();
  const remember = (page: EmployeeSizePage | null) => {
    if (!page?.url || !page.text.trim()) return;
    const key = page.url.replace(/\/$/, '').toLowerCase();
    if (seen.has(key) || isSkippedHost(page.url)) return;
    seen.add(key);
    pages.push(page);
  };
  if (company.website) remember(await deps.fetchPage(company.website));
  const results = await deps.search({
    companyName: company.name,
    city: company.city,
    state: company.state,
    category: 'employees',
  });
  for (const result of results.slice(0, 4)) {
    if (!result.url || isSkippedHost(result.url)) continue;
    remember(await deps.fetchPage(result.url));
  }
  return assessEmployeeSize(company, pages);
}

export function assessEmployeeSize(company: EmployeeSizeSubject, pages: EmployeeSizePage[]): EmployeeSizeAssessment {
  const findings: EmployeeSizeFinding[] = [];
  for (const page of pages) {
    if (isSkippedHost(page.url)) continue;
    const text = visibleText(page.text) || page.text;
    const extracted = extractEmployeeSize(text);
    if (!extracted) continue;
    if (!employeeSizePageMatchesCompany({ ...page, text }, company, extracted.excerpt)) continue;
    const source = classifyEmployeeSizeSource(page.url, company.website, page.text);
    findings.push({
      sourceUrl: page.url,
      sourceType: source.sourceType,
      excerpt: extracted.excerpt,
      value: extracted.kind === 'unusable' ? null : extracted,
      verified: source.verified && extracted.kind !== 'unusable',
      retrievedAt: new Date().toISOString(),
    });
  }
  return reconcileEmployeeSize(findings);
}

export function reconcileEmployeeSize(findings: EmployeeSizeFinding[]): EmployeeSizeAssessment {
  const comparable = findings.filter((finding): finding is EmployeeSizeFinding & { value: EmployeeSizeValue } => finding.value?.kind === 'exact' || finding.value?.kind === 'range');
  if (comparable.length === 0) {
    return { findings, outcome: 'none', employeeCount: null, employeeRange: null, conflict: null };
  }
  let chosen = comparable[0];
  for (const finding of comparable.slice(1)) {
    const relation = compareSizeSpans(spanOf(chosen.value), spanOf(finding.value));
    if (relation === 'conflict') {
      return {
        findings,
        outcome: 'conflict',
        employeeCount: null,
        employeeRange: null,
        conflict: { valueA: chosen.value.normalized, valueB: finding.value.normalized, left: chosen, right: finding },
      };
    }
    if (relation === 'narrower') chosen = finding;
  }
  if (chosen.value.kind === 'exact') {
    return { findings, outcome: 'value', employeeCount: chosen.value.count, employeeRange: null, conflict: null };
  }
  return { findings, outcome: 'value', employeeCount: null, employeeRange: chosen.value.normalized, conflict: null };
}

export function classifyEmployeeSizeSource(url: string, website?: string | null, text = ''): { sourceType: EmployeeSizeSourceType; verified: boolean } {
  if (sameSite(url, website)) return { sourceType: 'official_company', verified: true };
  const host = hostname(url);
  const reason = host ? classifyOfficialWebsiteHost(host) : null;
  if (reason === 'DIRECTORY') return { sourceType: 'public_directory', verified: false };
  if (/company profile|business profile/i.test(text)) return { sourceType: 'public_company_profile', verified: false };
  return { sourceType: 'other_public', verified: false };
}

export function isSkippedHost(url: string): boolean {
  const host = hostname(url);
  return host ? classifyOfficialWebsiteHost(host) === 'SOCIAL_PROFILE' : false;
}

function spanOf(value: EmployeeSizeValue): { min: number; max: number } {
  return value.kind === 'exact' ? { min: value.count, max: value.count } : { min: value.min, max: value.max };
}

function compareSizeSpans(current: { min: number; max: number }, next: { min: number; max: number }): 'same' | 'narrower' | 'wider' | 'conflict' {
  const contains = next.min >= current.min && next.max <= current.max;
  const contained = current.min >= next.min && current.max <= next.max;
  if (contains && contained) return 'same';
  if (contains) return 'narrower';
  if (contained) return 'wider';
  return 'conflict';
}

export function toEmployeeSizeEvidence(companyId: string, finding: EmployeeSizeFinding) {
  return {
    companyId,
    evidenceType: 'EMPLOYEE_SIZE' as const,
    sourceUrl: finding.sourceUrl,
    sourceType: finding.sourceType,
    provider: 'employee_size' as const,
    evidenceText: finding.excerpt,
    retrievedAt: finding.retrievedAt,
    verified: finding.verified,
    verificationStatus: finding.verified ? 'VERIFIED' as const : 'UNVERIFIED' as const,
    value: finding.value?.normalized ?? null,
  };
}

function hostname(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}
