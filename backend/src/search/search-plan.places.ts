import type { SearchLocation } from './types/search-plan.types';

const US_STATES: Record<string, string> = {
  al: 'Alabama', alabama: 'Alabama', ak: 'Alaska', alaska: 'Alaska', az: 'Arizona', arizona: 'Arizona',
  ar: 'Arkansas', arkansas: 'Arkansas', ca: 'California', california: 'California', co: 'Colorado', colorado: 'Colorado',
  ct: 'Connecticut', connecticut: 'Connecticut', de: 'Delaware', delaware: 'Delaware', fl: 'Florida', florida: 'Florida',
  ga: 'Georgia', georgia: 'Georgia', hi: 'Hawaii', hawaii: 'Hawaii', id: 'Idaho', idaho: 'Idaho', il: 'Illinois', illinois: 'Illinois',
  in: 'Indiana', indiana: 'Indiana', ia: 'Iowa', iowa: 'Iowa', ks: 'Kansas', kansas: 'Kansas', ky: 'Kentucky', kentucky: 'Kentucky',
  la: 'Louisiana', louisiana: 'Louisiana', me: 'Maine', maine: 'Maine', md: 'Maryland', maryland: 'Maryland',
  ma: 'Massachusetts', massachusetts: 'Massachusetts', mi: 'Michigan', michigan: 'Michigan', mn: 'Minnesota', minnesota: 'Minnesota',
  ms: 'Mississippi', mississippi: 'Mississippi', mo: 'Missouri', missouri: 'Missouri', mt: 'Montana', montana: 'Montana',
  ne: 'Nebraska', nebraska: 'Nebraska', nv: 'Nevada', nevada: 'Nevada', nh: 'New Hampshire', 'new hampshire': 'New Hampshire',
  nj: 'New Jersey', 'new jersey': 'New Jersey', nm: 'New Mexico', 'new mexico': 'New Mexico', ny: 'New York', 'new york': 'New York',
  nc: 'North Carolina', 'north carolina': 'North Carolina', nd: 'North Dakota', 'north dakota': 'North Dakota',
  oh: 'Ohio', ohio: 'Ohio', ok: 'Oklahoma', oklahoma: 'Oklahoma', or: 'Oregon', oregon: 'Oregon', pa: 'Pennsylvania', pennsylvania: 'Pennsylvania',
  ri: 'Rhode Island', 'rhode island': 'Rhode Island', sc: 'South Carolina', 'south carolina': 'South Carolina',
  sd: 'South Dakota', 'south dakota': 'South Dakota', tn: 'Tennessee', tennessee: 'Tennessee', tx: 'Texas', texas: 'Texas',
  ut: 'Utah', utah: 'Utah', vt: 'Vermont', vermont: 'Vermont', va: 'Virginia', virginia: 'Virginia', wa: 'Washington', washington: 'Washington',
  wv: 'West Virginia', 'west virginia': 'West Virginia', wi: 'Wisconsin', wisconsin: 'Wisconsin', wy: 'Wyoming', wyoming: 'Wyoming',
  dc: 'District of Columbia', 'district of columbia': 'District of Columbia', 'washington dc': 'District of Columbia',
};

const COUNTRIES: Record<string, string> = {
  us: 'US', usa: 'US', 'united states': 'US', 'united states of america': 'US', america: 'US',
  uk: 'United Kingdom', 'united kingdom': 'United Kingdom', britain: 'United Kingdom', england: 'United Kingdom',
  canada: 'Canada', mexico: 'Mexico', germany: 'Germany', deutschland: 'Germany', france: 'France', spain: 'Spain',
  italy: 'Italy', netherlands: 'Netherlands', holland: 'Netherlands', belgium: 'Belgium', switzerland: 'Switzerland',
  austria: 'Austria', sweden: 'Sweden', norway: 'Norway', denmark: 'Denmark', finland: 'Finland', ireland: 'Ireland',
  portugal: 'Portugal', poland: 'Poland', greece: 'Greece', czechia: 'Czechia', 'czech republic': 'Czechia',
  romania: 'Romania', hungary: 'Hungary', ukraine: 'Ukraine', turkey: 'Turkey', turkiye: 'Turkey',
  uae: 'United Arab Emirates', 'united arab emirates': 'United Arab Emirates', 'saudi arabia': 'Saudi Arabia',
  qatar: 'Qatar', kuwait: 'Kuwait', bahrain: 'Bahrain', oman: 'Oman', israel: 'Israel', jordan: 'Jordan',
  egypt: 'Egypt', pakistan: 'Pakistan', india: 'India', bangladesh: 'Bangladesh', 'sri lanka': 'Sri Lanka',
  china: 'China', japan: 'Japan', 'south korea': 'South Korea', korea: 'South Korea', singapore: 'Singapore',
  malaysia: 'Malaysia', indonesia: 'Indonesia', thailand: 'Thailand', vietnam: 'Vietnam', philippines: 'Philippines',
  australia: 'Australia', 'new zealand': 'New Zealand', brazil: 'Brazil', argentina: 'Argentina', chile: 'Chile',
  colombia: 'Colombia', peru: 'Peru', 'south africa': 'South Africa', nigeria: 'Nigeria', kenya: 'Kenya',
  morocco: 'Morocco',
};

const CITIES: Record<string, { city: string; country: string; state?: string }> = {
  dubai: { city: 'Dubai', country: 'United Arab Emirates' },
  'abu dhabi': { city: 'Abu Dhabi', country: 'United Arab Emirates' },
  lahore: { city: 'Lahore', country: 'Pakistan' },
  karachi: { city: 'Karachi', country: 'Pakistan' },
  islamabad: { city: 'Islamabad', country: 'Pakistan' },
  berlin: { city: 'Berlin', country: 'Germany' },
  munich: { city: 'Munich', country: 'Germany' },
  hamburg: { city: 'Hamburg', country: 'Germany' },
  frankfurt: { city: 'Frankfurt', country: 'Germany' },
  london: { city: 'London', country: 'United Kingdom' },
  paris: { city: 'Paris', country: 'France' },
  toronto: { city: 'Toronto', country: 'Canada', state: 'Ontario' },
  vancouver: { city: 'Vancouver', country: 'Canada', state: 'British Columbia' },
};

const EXPANSION_CITIES: Record<string, string[]> = {
  'us|texas': ['Houston', 'Dallas', 'Austin', 'San Antonio', 'Fort Worth', 'El Paso', 'Arlington', 'Plano', 'Corpus Christi', 'Lubbock', 'Laredo', 'Irving', 'Frisco', 'McKinney', 'Amarillo', 'Brownsville', 'Waco', 'Denton', 'Midland', 'Abilene', 'Beaumont', 'Round Rock', 'Tyler', 'Pearland', 'Sugar Land'],
  'us|california': ['Los Angeles', 'San Francisco', 'San Diego', 'San Jose', 'Sacramento', 'Oakland', 'Fresno', 'Irvine', 'Santa Ana', 'Long Beach', 'Anaheim', 'Bakersfield'],
  'us|new york': ['New York', 'Buffalo', 'Rochester', 'Albany', 'Syracuse', 'Yonkers'],
  'us|florida': ['Miami', 'Orlando', 'Tampa', 'Jacksonville', 'Fort Lauderdale', 'St. Petersburg', 'Tallahassee'],
  'germany|': ['Berlin', 'Munich', 'Hamburg', 'Frankfurt', 'Cologne', 'Stuttgart', 'Dusseldorf'],
  'united arab emirates|': ['Dubai', 'Abu Dhabi', 'Sharjah'],
  'pakistan|': ['Lahore', 'Karachi', 'Islamabad', 'Rawalpindi', 'Faisalabad'],
  'united kingdom|': ['London', 'Manchester', 'Birmingham', 'Leeds', 'Glasgow'],
};

export function interpretPlace(raw: string): SearchLocation {
  const text = raw.replace(/^the\s+/i, '').replace(/[?.!,]+$/g, '').trim();
  const parts = text.split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const head = parts[0];
    const tail = parts[parts.length - 1];
    const country = lookupCountry(tail);
    const state = lookupState(tail);
    if (country) return { city: titleCase(head), country, ...(parts.length > 2 ? { state: titleCase(parts[1]) } : {}) };
    if (state) return { city: titleCase(head), state: state.name, country: state.country };
    return { city: titleCase(head), region: titleCase(tail), country: '' };
  }
  const country = lookupCountry(text);
  if (country) return { country };
  const state = lookupState(text);
  if (state) return { country: state.country, state: state.name };
  const city = CITIES[text.toLowerCase()];
  if (city) return { city: city.city, country: city.country, ...(city.state ? { state: city.state } : {}) };
  return { city: titleCase(text), country: '' };
}

export function expansionCities(location: SearchLocation): string[] {
  if (location.city?.trim()) return [];
  const country = (location.country || '').trim().toLowerCase();
  const state = (location.state || '').trim().toLowerCase();
  return EXPANSION_CITIES[`${country}|${state}`] ?? [];
}

export function placeMentioned(text: string, location: SearchLocation): string | null {
  const haystack = text.replace(/\s+/g, ' ');
  const candidates = [location.city, location.state, location.region, location.country]
    .filter((part): part is string => Boolean(part?.trim()));
  if (location.country === 'US' && location.state) {
    const code = stateCode(location.state);
    if (code) candidates.push(code);
  }
  const country = location.country ?? '';
  if (/germany/i.test(country)) candidates.push('Deutschland');
  if (/united arab emirates/i.test(country)) candidates.push('UAE');
  if (/united kingdom/i.test(country)) candidates.push('UK');
  if (/^us$/i.test(country) && !location.state && !location.city) candidates.push('United States', 'USA');
  for (const candidate of candidates) {
    if (candidate.length <= 3) {
      if (new RegExp(`\\b${escapeRegExp(candidate)}\\b`).test(haystack)) return candidate;
      continue;
    }
    if (new RegExp(`\\b${escapeRegExp(candidate)}\\b`, 'i').test(haystack)) return candidate;
  }
  if (location.state && /^texas$/i.test(location.state)) {
    const city = (EXPANSION_CITIES['us|texas'] ?? []).find((name) => new RegExp(`\\b${escapeRegExp(name)}\\b`, 'i').test(haystack));
    if (city) return city;
  }
  const expanded = expansionCities(location).find((name) => new RegExp(`\\b${escapeRegExp(name)}\\b`, 'i').test(haystack));
  return expanded ?? null;
}

function lookupCountry(value: string): string | undefined {
  return COUNTRIES[value.trim().toLowerCase().replace(/\./g, '')];
}

function lookupState(value: string): { name: string; country: string } | undefined {
  const name = US_STATES[value.trim().toLowerCase().replace(/\./g, '')];
  return name ? { name, country: 'US' } : undefined;
}

function stateCode(state: string): string | undefined {
  const target = state.trim().toLowerCase();
  const code = Object.entries(US_STATES).find(([key, name]) => name.toLowerCase() === target && key.length === 2)?.[0];
  return code ? code.toUpperCase() : undefined;
}

function titleCase(value: string): string {
  return value.split(/\s+/).map((word) => word ? word.charAt(0).toUpperCase() + word.slice(1) : word).join(' ');
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
