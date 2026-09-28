const GENERIC_TOKENS = new Set([
  'the', 'and', 'llc', 'inc', 'incorporated', 'corp', 'corporation', 'company', 'companies', 'group',
  'holdings', 'holding', 'investment', 'investments', 'investor', 'investors', 'services', 'service',
  'advisors', 'advisor', 'capital', 'resources', 'partners', 'partner',
]);

export interface EmployeeSizeSubject {
  name: string;
  website?: string | null;
  city?: string | null;
  state?: string | null;
  description?: string | null;
}

export function employeeSizePageMatchesCompany(
  page: { url: string; title: string; text: string },
  company: EmployeeSizeSubject,
  excerpt: string,
): boolean {
  const name = comparableName(company.name);
  if (!name) return false;
  const haystack = normalize(`${page.title} ${page.text}`);
  const vicinity = normalize(`${page.title} ${vicinityText(page.text, excerpt)}`);
  const official = sameSite(page.url, company.website);
  const named = haystack.includes(name) && vicinity.includes(name);
  if (!named && !official) return false;
  if (!named) {
    const tokens = distinctiveTokens(company.name);
    if (tokens.length === 0 || tokens.some((token) => !haystack.includes(token) || !vicinity.includes(token))) return false;
  }
  if (namesADifferentOrganization(`${page.title} ${excerpt}`, company.name)) return false;
  if (official) return true;
  if (company.city?.trim()) return haystack.includes(normalize(company.city));
  if (company.state?.trim()) return mentionsState(haystack, company.state);
  return false;
}

function namesADifferentOrganization(text: string, companyName: string): boolean {
  const name = comparableName(companyName);
  if (!name) return false;
  const haystack = normalize(text);
  const index = haystack.indexOf(name);
  if (index < 0) return false;
  if (index > 0 && haystack[index - 1] !== ' ') return false;
  const after = haystack.slice(index + name.length).trim();
  return /^(?:[a-z0-9]+\s+){1,4}(?:llc|inc|incorporated|corp|corporation|ltd|limited|company|co)\b/.test(after);
}

export function sameSite(left?: string | null, right?: string | null): boolean {
  const leftHost = hostname(left);
  const rightHost = hostname(right);
  if (!leftHost || !rightHost) return false;
  return leftHost === rightHost || leftHost.endsWith(`.${rightHost}`) || rightHost.endsWith(`.${leftHost}`);
}

function comparableName(name: string): string {
  return normalize(name).replace(/\b(?:llc|inc|incorporated|corp|corporation|ltd|limited|company|co)\b/g, ' ').replace(/\s+/g, ' ').trim();
}

function distinctiveTokens(name: string): string[] {
  return normalize(name).split(' ').filter((token) => token.length >= 3 && !GENERIC_TOKENS.has(token));
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function vicinityText(text: string, excerpt: string): string {
  const index = text.toLowerCase().indexOf(excerpt.toLowerCase().slice(0, 40));
  if (index < 0) return excerpt;
  return text.slice(Math.max(0, index - 180), Math.min(text.length, index + excerpt.length + 180));
}

function mentionsState(haystack: string, state: string): boolean {
  const normalized = normalize(state);
  const aliases = normalized === 'texas' || normalized === 'tx' ? ['texas', 'tx'] : [normalized];
  return aliases.some((alias) => haystack.includes(alias));
}

function hostname(value?: string | null): string | null {
  if (!value?.trim()) return null;
  try {
    return new URL(value.includes('://') ? value : `https://${value}`).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}
