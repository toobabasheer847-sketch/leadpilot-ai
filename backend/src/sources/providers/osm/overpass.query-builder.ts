import { SearchLocation, SearchPlan } from '../../../search/types/search-plan.types';
import { SourceProviderError } from '../source-provider.error';

const MAX_LOCATIONS = 3;
const MAX_SELECTORS = 8;
const SAFE_LITERAL = /^[\p{L}\p{N} .'-]+$/u;
const SAFE_TERM = /^[a-z0-9_ ]{1,40}$/i;

const CATEGORY_SELECTORS: Record<string, readonly string[]> = {
  real_estate: ['["office"="estate_agent"]', '["shop"="estate_agent"]'],
  real_estate_investor: ['["office"="estate_agent"]', '["office"="property_management"]'],
  cash_home_buyer: ['["office"="estate_agent"]'],
  house_flipper: ['["office"="estate_agent"]', '["office"="property_management"]'],
  fix_and_flip: ['["office"="estate_agent"]', '["office"="property_management"]'],
  buy_and_hold: ['["office"="estate_agent"]', '["office"="property_management"]'],
  brrrr: ['["office"="estate_agent"]', '["office"="property_management"]'],
  commercial_real_estate_investor: ['["office"="estate_agent"]', '["office"="property_management"]'],
  land_investor: ['["office"="estate_agent"]'],
  construction: ['["office"="construction_company"]', '["craft"="builder"]'],
  software: ['["office"="it"]'],
  marketing: ['["office"="advertising_agency"]'],
  healthcare: ['["amenity"="clinic"]', '["amenity"="doctors"]', '["amenity"="hospital"]'],
  legal: ['["office"="lawyer"]'],
  finance: ['["office"="financial"]', '["office"="insurance"]'],
};

const MAX_WINDOW_DEGREES = 1;

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
    ...selectors.map((selector) => `  node${selector}["name"]${box};`),
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
  return [location.city, location.state, location.country]
    .filter((part): part is string => Boolean(part?.trim()))
    .map((part) => assertLocationText(part))
    .join(', ');
}

export function searchWindows(bbox: OverpassBBox): OverpassBBox[] {
  const normalized = normalizedBBox(bbox);
  const latSpan = normalized.north - normalized.south;
  const lonSpan = normalized.east - normalized.west;
  if (latSpan <= MAX_WINDOW_DEGREES && lonSpan <= MAX_WINDOW_DEGREES) return [normalized];
  return [0.7, 0.5, 0.3].map((ratio) => windowAt(normalized, ratio, ratio));
}

function windowAt(bbox: OverpassBBox, latRatio: number, lonRatio: number): OverpassBBox {
  const latSpan = bbox.north - bbox.south;
  const lonSpan = bbox.east - bbox.west;
  const height = Math.min(MAX_WINDOW_DEGREES, latSpan);
  const width = Math.min(MAX_WINDOW_DEGREES, lonSpan);
  return fitWindow(bbox, {
    south: bbox.south + (latSpan * latRatio) - (height / 2),
    north: bbox.south + (latSpan * latRatio) + (height / 2),
    west: bbox.west + (lonSpan * lonRatio) - (width / 2),
    east: bbox.west + (lonSpan * lonRatio) + (width / 2),
  });
}

function fitWindow(bounds: OverpassBBox, window: OverpassBBox): OverpassBBox {
  let { south, west, north, east } = window;
  if (south < bounds.south) {
    north += bounds.south - south;
    south = bounds.south;
  }
  if (north > bounds.north) {
    south -= north - bounds.north;
    north = bounds.north;
  }
  if (west < bounds.west) {
    east += bounds.west - west;
    west = bounds.west;
  }
  if (east > bounds.east) {
    west -= east - bounds.east;
    east = bounds.east;
  }
  return { south, west, north, east };
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

function categorySelectors(plan: SearchPlan): string[] {
  const selectors: string[] = [];
  for (const term of [...plan.industry, ...plan.leadTypes]) {
    const key = term.trim().toLowerCase().replace(/\s+/g, '_');
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
    if (!location?.country?.trim()) continue;
    const key = [location.country, location.state ?? '', location.city ?? ''].map((part) => part.trim().toLowerCase()).join('|');
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
