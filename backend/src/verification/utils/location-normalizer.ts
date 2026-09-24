const stateNames: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT', florida: 'FL', georgia: 'GA', illinois: 'IL', newyork: 'NY', northcarolina: 'NC', ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', texas: 'TX', utah: 'UT', virginia: 'VA', washington: 'WA', wisconsin: 'WI',
};

export function normalizeState(value: string | null): string | null {
  if (!value) return null;
  const cleaned = value.trim();
  if (/^[A-Za-z]{2}$/.test(cleaned)) return cleaned.toUpperCase();
  return stateNames[cleaned.toLowerCase().replace(/\s+/g, '')] ?? cleaned;
}
