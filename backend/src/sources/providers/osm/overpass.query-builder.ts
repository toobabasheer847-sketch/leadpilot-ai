import { SearchLocation, SearchPlan } from '../../../search/types/search-plan.types';
import { SourceProviderError } from '../source-provider.error';
import { pointInTexas } from './texas.boundary';

const MAX_LOCATIONS = 3;
const MAX_SELECTORS = 8;
const SAFE_LITERAL = /^[\p{L}\p{N} .'-]+$/u;
const SAFE_TERM = /^[a-z0-9_ ]{1,40}$/i;
/** A box at or below this size is one query. Larger areas are tiled instead of sampled. */
const SINGLE_QUERY_DEGREES = 4;
/** Hard cap on geographic partitions for one location. The tiles still cover the whole box. */
export const MAX_DISCOVERY_PARTITIONS = 12;
const INVESTOR_NAME_PATTERN = 'investor|investment|acquisition|holdings|buy and hold|fix and flip';
const INVESTOR_SELECTOR = `["office"]["office"!="estate_agent"]["office"!="property_management"]["office"!="insurance"]["name"~"${INVESTOR_NAME_PATTERN}",i]`;

const INVESTOR_POSITIVE = /\b(investors?|investments?|acquisitions?|holdings)\b|\bbuy and hold\b|\bfix and flip\b/i;
const INVESTOR_NAME_EXCLUSIONS = [
  /\breal estate agents?\b/i,
  /\brealtors?\b/i,
  /\brealty\b/i,
  /\bbrokerages?\b/i,
  /\bbrokers?\b/i,
  /\bmortgage\b/i,
  /\btitle compan(?:y|ies)\b/i,
  /\binsurance\b/i,
  /\bproperty management\b/i,
  /\bapartment leasing\b/i,
  /\bleasing office\b/i,
  /\bdirectory\b/i,
];
const INVESTOR_CATEGORY_EXCLUSIONS = [/estate agent/i, /property management/i, /insurance/i, /mortgage/i];

const CATEGORY_SELECTORS: Record<string, readonly string[]> = {
  real_estate: ['["office"="estate_agent"]', '["shop"="estate_agent"]'],
  real_estate_investor: [INVESTOR_SELECTOR],
  cash_home_buyer: ['["office"]["name"~"investor|investments|acquisition|home buyer",i]'],
  house_flipper: [INVESTOR_SELECTOR],
  fix_and_flip: [INVESTOR_SELECTOR],
  buy_and_hold: [INVESTOR_SELECTOR],
  brrrr: [INVESTOR_SELECTOR],
  commercial_real_estate_investor: [INVESTOR_SELECTOR],
  land_investor: [INVESTOR_SELECTOR],
  construction: ['["office"="construction_company"]', '["craft"="builder"]'],
  software: ['["office"="it"]["name"~"software|saas",i]', '["office"="company"]["name"~"software|saas",i]'],
  marketing: ['["office"="advertising_agency"]'],
  healthcare: ['["amenity"="clinic"]', '["amenity"="doctors"]', '["amenity"="hospital"]'],
  legal: ['["office"="lawyer"]'],
  finance: ['["office"="financial"]', '["office"="insurance"]'],
  restaurant: ['["amenity"="restaurant"]'],
  restaurants: ['["amenity"="restaurant"]'],
};

export interface OverpassBBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface OverpassQueryOptions {
  timeoutSeconds: number;
  maxResults: number;
  bbox: OverpassBBox;
}

export function buildOverpassQuery(plan: SearchPlan, options: OverpassQueryOptions): string {
  const selectors = categorySelectors(plan);
  if (selectors.length === 0) {
    throw new SourceProviderError('PROVIDER_INVALID_REQUEST', 'OpenStreetMap discovery requires a business category.');
  }
  const bbox = normalizedBBox(options.bbox);
  const timeoutSeconds = clamp(options.timeoutSeconds, 1, 25, 25);
  const maxResults = clamp(options.maxResults, 1, 100, 100);
  const box = `(${coordinate(bbox.south, 90)},${coordinate(bbox.west, 180)},${coordinate(bbox.north, 90)},${coordinate(bbox.east, 180)})`;
  return [
    `[out:json][timeout:${timeoutSeconds}];`,
    '(',
    ...selectors.flatMap((selector) => [
      `  node${selector}["name"]${box};`,
      `  way${selector}["name"]${box};`,
      `  relation${selector}["name"]${box};`,
    ]),
    ');',
    `out center ${maxResults};`,
  ].join('\n');
}

export function discoveryLocations(plan: SearchPlan): SearchLocation[] {
  const locations = uniqueLocations(plan.locations).slice(0, MAX_LOCATIONS);
  if (locations.length === 0) {
    throw new SourceProviderError('PROVIDER_INVALID_REQUEST', 'OpenStreetMap discovery requires a location.');
  }
  return locations;
}

export function locationLabel(location: SearchLocation): string {
  return [location.city, location.state, location.region, location.country]
    .filter((part): part is string => Boolean(part?.trim()))
    .map((part) => assertLocationText(part))
    .join(', ');
}

export function searchWindows(bbox: OverpassBBox): OverpassBBox[] {
  const normalized = normalizedBBox(bbox);
  const latSpan = normalized.north - normalized.south;
  const lonSpan = normalized.east - normalized.west;
  if (latSpan <= SINGLE_QUERY_DEGREES && lonSpan <= SINGLE_QUERY_DEGREES) return [normalized];
  let rows = Math.max(1, Math.ceil(latSpan / SINGLE_QUERY_DEGREES));
  let cols = Math.max(1, Math.ceil(lonSpan / SINGLE_QUERY_DEGREES));
  while (rows * cols > MAX_DISCOVERY_PARTITIONS && (rows > 1 || cols > 1)) {
    if (cols >= rows && cols > 1) cols -= 1;
    else rows -= 1;
  }
  return tile(normalized, rows, cols);
}

function tile(bbox: OverpassBBox, rows: number, cols: number): OverpassBBox[] {
  const latStep = (bbox.north - bbox.south) / rows;
  const lonStep = (bbox.east - bbox.west) / cols;
  const cells: OverpassBBox[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      cells.push({
        south: bbox.south + (row * latStep),
        north: bbox.south + ((row + 1) * latStep),
        west: bbox.west + (col * lonStep),
        east: bbox.west + ((col + 1) * lonStep),
      });
    }
  }
  return cells;
}

export function isRealEstateInvestorDiscovery(plan: SearchPlan): boolean {
  return [...plan.leadTypes, ...plan.industry].some((term) => {
    const key = term.trim().toLowerCase().replace(/\s+/g, '_');
    return key === 'real_estate_investor'
      || key === 'commercial_real_estate_investor'
      || key === 'land_investor'
      || key === 'house_flipper'
      || key === 'fix_and_flip'
      || key === 'buy_and_hold'
      || key === 'brrrr';
  });
}

const STATE_NAMES: Record<string, string> = {
  al: 'alabama', ak: 'alaska', az: 'arizona', ar: 'arkansas', ca: 'california', co: 'colorado', ct: 'connecticut',
  de: 'delaware', fl: 'florida', ga: 'georgia', hi: 'hawaii', id: 'idaho', il: 'illinois', in: 'indiana', ia: 'iowa',
  ks: 'kansas', ky: 'kentucky', la: 'louisiana', me: 'maine', md: 'maryland', ma: 'massachusetts', mi: 'michigan',
  mn: 'minnesota', ms: 'mississippi', mo: 'missouri', mt: 'montana', ne: 'nebraska', nv: 'nevada', nh: 'new hampshire',
  nj: 'new jersey', nm: 'new mexico', ny: 'new york', nc: 'north carolina', nd: 'north dakota', oh: 'ohio', ok: 'oklahoma',
  or: 'oregon', pa: 'pennsylvania', ri: 'rhode island', sc: 'south carolina', sd: 'south dakota', tn: 'tennessee',
  tx: 'texas', ut: 'utah', vt: 'vermont', va: 'virginia', wa: 'washington', wv: 'west virginia', wi: 'wisconsin', wy: 'wyoming',
};

export function matchesRequestedState(requested: string | undefined, found: string | undefined): boolean {
  if (!requested?.trim() || !found?.trim()) return true;
  return canonicalState(requested) === canonicalState(found);
}

/** Missing coordinates stay eligible. A recorded point outside Texas does not. */
export function coordinateWithinRequestedState(requested: string | undefined, latitude?: number, longitude?: number): boolean {
  if (!requested?.trim() || canonicalState(requested) !== 'texas') return true;
  if (typeof latitude !== 'number' || typeof longitude !== 'number') return true;
  return pointInTexas(latitude, longitude);
}

function canonicalState(value: string): string {
  const key = value.trim().toLowerCase().replace(/\./g, '');
  return STATE_NAMES[key] ?? key;
}

export function investorCandidateAllowed(name: string, category?: string | null): boolean {
  if (INVESTOR_NAME_EXCLUSIONS.some((pattern) => pattern.test(name))) return false;
  if (INVESTOR_CATEGORY_EXCLUSIONS.some((pattern) => pattern.test(category ?? ''))) return false;
  return INVESTOR_POSITIVE.test(name);
}

export function assertLocationText(value: string): string {
  const cleaned = stripControls(value.normalize('NFKC')).trim();
  if (!cleaned || cleaned.length > 80 || !SAFE_LITERAL.test(cleaned)) {
    throw new SourceProviderError('PROVIDER_INVALID_REQUEST', 'OpenStreetMap discovery rejected an unsupported location value.');
  }
  return cleaned;
}

function normalizedBBox(bbox: OverpassBBox): OverpassBBox {
  if (!bbox || [bbox.south, bbox.west, bbox.north, bbox.east].some((value) => !Number.isFinite(value))) {
    throw new SourceProviderError('PROVIDER_INVALID_REQUEST', 'OpenStreetMap discovery requires a location.');
  }
  if (bbox.south >= bbox.north || bbox.west >= bbox.east) {
    throw new SourceProviderError('PROVIDER_INVALID_REQUEST', 'OpenStreetMap discovery requires a location.');
  }
  return bbox;
}

function coordinate(value: number, limit: number): string {
  if (value < -limit || value > limit) {
    throw new SourceProviderError('PROVIDER_INVALID_REQUEST', 'OpenStreetMap discovery requires a location.');
  }
  return value.toFixed(6);
}

const INVESTOR_DISCOVERY_KEYS = new Set([
  'real_estate_investor', 'cash_home_buyer', 'house_flipper', 'fix_and_flip', 'buy_and_hold', 'brrrr',
  'commercial_real_estate_investor', 'land_investor',
]);

function categorySelectors(plan: SearchPlan): string[] {
  const selectors: string[] = [];
  const investorSearch = [...plan.leadTypes, ...plan.industry].some((term) => INVESTOR_DISCOVERY_KEYS.has(term.trim().toLowerCase().replace(/\s+/g, '_')));
  for (const term of [...plan.industry, ...plan.leadTypes]) {
    const key = term.trim().toLowerCase().replace(/\s+/g, '_');
    if (investorSearch && key === 'real_estate') continue;
    const known = CATEGORY_SELECTORS[key];
    if (known) {
      selectors.push(...known);
      continue;
    }
    const phrase = term.trim().toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ');
    if (!SAFE_TERM.test(phrase) || phrase.replace(/\s+/g, '').length < 3) continue;
    const pattern = phrase.replace(/[\\^$.|?*+()[\]{}]/g, '\\$&');
    selectors.push(
      `["office"]["name"~"${pattern}",i]`,
      `["shop"]["name"~"${pattern}",i]`,
      `["amenity"]["name"~"${pattern}",i]`,
    );
  }
  return [...new Set(selectors)].slice(0, MAX_SELECTORS);
}

function uniqueLocations(locations: SearchLocation[]): SearchLocation[] {
  const seen = new Set<string>();
  const unique: SearchLocation[] = [];
  for (const location of locations ?? []) {
    const country = location.country?.trim() ?? '';
    const state = location.state?.trim() ?? '';
    const city = location.city?.trim() ?? '';
    const region = location.region?.trim() ?? '';
    if (!country && !state && !city && !region) continue;
    const key = [country, state, city, region].map((part) => part.toLowerCase()).join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(location);
  }
  return unique;
}

function stripControls(value: string): string {
  let cleaned = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) continue;
    cleaned += char;
  }
  return cleaned;
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}
