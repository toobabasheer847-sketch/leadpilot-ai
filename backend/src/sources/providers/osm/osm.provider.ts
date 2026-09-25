import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OutboundRequestError, OutboundRequestService } from '../../../common/outbound-request.service';
import { SearchPlan } from '../../../search/types/search-plan.types';
import { phoneMatchKey } from '../../services/company-field-merge';
import { SourceNormalizerService } from '../../services/source-normalizer.service';
import { NormalizedSourceResult, SourceProvider, SourceSearchContext, SourceSearchResult } from '../../types/source.types';
import { isRetryableProviderError, SourceProviderError } from '../source-provider.error';
import { OverpassElement, OverpassResponse } from './osm.types';
import { buildOverpassQuery, discoveryLocations, locationLabel, searchWindows } from './overpass.query-builder';
import type { OverpassBBox } from './overpass.query-builder';

const OSM_PROVIDER_NAME = 'osm';
const OSM_ELEMENT_TYPES = new Set(['node', 'way', 'relation']);
const RAW_TAG_KEYS = [
  'name', 'office', 'shop', 'amenity', 'craft', 'healthcare', 'tourism', 'building',
  'website', 'contact:website', 'url', 'phone', 'contact:phone', 'contact:mobile', 'mobile',
  'email', 'contact:email', 'addr:housenumber', 'addr:street', 'addr:full', 'addr:city',
  'addr:state', 'addr:postcode', 'addr:country',
];
const CATEGORY_KEYS = ['office', 'shop', 'amenity', 'craft', 'healthcare', 'tourism'] as const;

@Injectable()
export class OsmSourceProvider implements SourceProvider {
  readonly name = OSM_PROVIDER_NAME;
  private readonly endpoint?: string;
  private readonly geocoderUrl?: string;
  private readonly maxResults: number;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retryDelayMs: number;
  private readonly retainRawData: boolean;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly outbound: OutboundRequestService,
    private readonly normalizer: SourceNormalizerService,
    configService: ConfigService,
  ) {
    this.endpoint = httpsEndpoint(configService.get<string>('sourceProvider.overpassApiUrl'));
    this.geocoderUrl = httpsEndpoint(configService.get<string>('sourceProvider.nominatimApiUrl') || 'https://nominatim.openstreetmap.org/search');
    this.maxResults = clamp(configService.get<number>('sourceProvider.overpassMaxResults'), 1, 100, 100);
    this.timeoutMs = clamp(configService.get<number>('sourceProvider.overpassTimeoutMs'), 1000, 60000, 30000);
    this.retries = Math.min(2, nonNegativeInt(configService.get<number>('sourceProvider.retries'), 2));
    this.retryDelayMs = nonNegativeInt(configService.get<number>('sourceProvider.retryDelayMs'), 250);
    this.retainRawData = configService.get<boolean>('sourceProvider.retainRawData') !== false;
  }

  providerName() { return this.name; }
  getProviderName() { return this.providerName(); }
  getSourceType() { return this.name; }
  metadata() { return { provider: this.name, sourceType: this.name, synthetic: false }; }
  health() {
    const configured = Boolean(this.endpoint && this.geocoderUrl);
    return { name: this.name, configured, enabled: configured };
  }

  search(plan: SearchPlan, context: SourceSearchContext) {
    return this.searchBusinesses(plan, context);
  }

  async searchBusinesses(plan: SearchPlan, _context: SourceSearchContext): Promise<SourceSearchResult> {
    if (!this.endpoint || !this.geocoderUrl) {
      throw new SourceProviderError('PROVIDER_NOT_CONFIGURED', 'OpenStreetMap provider is not configured.');
    }
    const locations = discoveryLocations(plan);
    const timeoutSeconds = Math.min(25, Math.max(1, Math.floor(this.timeoutMs / 1000) - 5));
    const resultLimit = clamp(plan.maxResults ?? this.maxResults, 1, this.maxResults, this.maxResults);
    return this.enqueue(async () => {
      const normalized: NormalizedSourceResult[] = [];
      for (const location of locations) {
        if (normalized.length >= resultLimit) break;
        const bbox = await this.geocode(locationLabel(location));
        for (const window of searchWindows(bbox)) {
          if (normalized.length >= resultLimit) break;
          const query = buildOverpassQuery(plan, {
            timeoutSeconds,
            maxResults: resultLimit - normalized.length,
            bbox: window,
          });
          const payload = await this.requestWithRetry(query);
          for (const element of payload.elements ?? []) {
            try {
              normalized.push(this.normalizeResult(element));
            } catch (error) {
              if (!(error instanceof SourceProviderError)) throw error;
            }
          }
        }
      }
      return { provider: this.name, results: dedupeResults(normalized).slice(0, resultLimit) };
    });
  }

  normalizeResult(raw: unknown): NormalizedSourceResult {
    if (!raw || typeof raw !== 'object') {
      throw new SourceProviderError('PROVIDER_INVALID_REQUEST', 'OpenStreetMap provider returned an invalid response.');
    }
    const element = raw as OverpassElement;
    const type = element.type?.trim() ?? '';
    const id = element.id;
    const tags = stringTags(element.tags);
    const name = firstValue(tags.name);
    if (!OSM_ELEMENT_TYPES.has(type) || !Number.isSafeInteger(id) || (id as number) <= 0 || !name || name.length > 255) {
      throw new SourceProviderError('PROVIDER_INVALID_REQUEST', 'OpenStreetMap provider returned a result without required provenance.');
    }
    const externalId = `${type}/${id}`;
    const sourceUrl = `https://www.openstreetmap.org/${type}/${id}`;
    const latitude = finiteCoordinate(element.lat ?? element.center?.lat);
    const longitude = finiteCoordinate(element.lon ?? element.center?.lon);
    const address = {
      addressLine1: streetLine(tags),
      city: bounded(firstValue(tags['addr:city']), 120),
      state: bounded(firstValue(tags['addr:state']), 100),
      postalCode: bounded(firstValue(tags['addr:postcode']), 20),
      country: twoLetterCountry(firstValue(tags['addr:country'])),
      latitude,
      longitude,
    };
    return {
      externalId,
      name,
      website: this.websiteFrom(tags),
      phone: this.normalizer.normalizePhone(firstValue(tags.phone) ?? firstValue(tags['contact:phone']) ?? firstValue(tags['contact:mobile']) ?? firstValue(tags.mobile)),
      email: this.normalizer.normalizeEmail(firstValue(tags.email) ?? firstValue(tags['contact:email'])),
      category: categoryFrom(tags),
      sourceUrl,
      ...(Object.values(address).some((value) => value !== undefined) ? { address } : {}),
      ...(this.retainRawData ? { rawData: rawData(type, id as number, tags) } : {}),
    };
  }

  private async geocode(label: string): Promise<OverpassBBox> {
    const url = new URL(this.geocoderUrl as string);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('limit', '1');
    url.searchParams.set('q', label);
    let response: Response;
    try {
      response = await this.outbound.fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'User-Agent': 'LeadPilotAI/1.0 (OpenStreetMap discovery)',
        },
      }, Math.min(this.timeoutMs, 10000));
    } catch (error) {
      const timedOut = error instanceof OutboundRequestError && /timed out/i.test(error.message);
      throw new SourceProviderError(timedOut ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNAVAILABLE', timedOut ? 'OpenStreetMap provider request timed out.' : 'OpenStreetMap provider is unavailable.');
    }
    if (response.status === 429) {
      await discard(response);
      throw new SourceProviderError('PROVIDER_RATE_LIMITED', 'OpenStreetMap provider rate limit reached.');
    }
    if (response.status >= 500) {
      await discard(response);
      throw new SourceProviderError('PROVIDER_UNAVAILABLE', 'OpenStreetMap provider is unavailable.');
    }
    if (!response.ok) {
      await discard(response);
      throw new SourceProviderError('PROVIDER_INVALID_REQUEST', 'OpenStreetMap discovery could not resolve the search location.');
    }
    try {
      const payload: unknown = await response.json();
      return bboxFromGeocoder(payload);
    } catch (error) {
      if (error instanceof SourceProviderError) throw error;
      throw new SourceProviderError('PROVIDER_UNKNOWN_ERROR', 'OpenStreetMap provider returned an invalid response.');
    }
  }

  private websiteFrom(tags: Record<string, string>) {
    const raw = firstValue(tags.website) ?? firstValue(tags['contact:website']) ?? firstValue(tags.url);
    if (!raw) return undefined;
    try {
      const url = new URL(raw);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    } catch {
      return undefined;
    }
    return this.normalizer.normalizeWebsite(raw);
  }

  private async requestWithRetry(query: string): Promise<OverpassResponse> {
    let attempt = 0;
    for (;;) {
      try {
        return await this.request(query);
      } catch (error) {
        const retryable = error instanceof SourceProviderError
          && isRetryableProviderError(error)
          && error.code !== 'PROVIDER_RATE_LIMITED'
          && error.code !== 'PROVIDER_TIMEOUT'
          && attempt < this.retries;
        if (!retryable) throw error;
        await delay(this.retryDelayMs * (2 ** attempt));
        attempt += 1;
      }
    }
  }

  private async request(query: string): Promise<OverpassResponse> {
    let response: Response;
    try {
      response = await this.outbound.fetch(this.endpoint as string, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          'User-Agent': 'LeadPilotAI/1.0 (OpenStreetMap discovery)',
        },
        body: `data=${encodeURIComponent(query)}`,
      }, this.timeoutMs);
    } catch (error) {
      const timedOut = error instanceof OutboundRequestError && /timed out/i.test(error.message);
      throw new SourceProviderError(timedOut ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNAVAILABLE', timedOut ? 'OpenStreetMap provider request timed out.' : 'OpenStreetMap provider is unavailable.');
    }

    if (response.status === 429) {
      await discard(response);
      throw new SourceProviderError('PROVIDER_RATE_LIMITED', 'OpenStreetMap provider rate limit reached.');
    }
    if (response.status === 400) {
      await discard(response);
      throw new SourceProviderError('PROVIDER_INVALID_REQUEST', 'OpenStreetMap provider rejected the search request.');
    }
    if (response.status >= 500) {
      await discard(response);
      throw new SourceProviderError('PROVIDER_UNAVAILABLE', 'OpenStreetMap provider is unavailable.');
    }
    if (!response.ok) {
      await discard(response);
      throw new SourceProviderError('PROVIDER_UNKNOWN_ERROR', 'OpenStreetMap provider request failed.');
    }

    try {
      const payload: unknown = await response.json();
      return parseOverpassPayload(payload);
    } catch (error) {
      if (error instanceof SourceProviderError) throw error;
      throw new SourceProviderError('PROVIDER_UNKNOWN_ERROR', 'OpenStreetMap provider returned an invalid response.');
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(operation, operation);
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }
}

function bboxFromGeocoder(payload: unknown): OverpassBBox {
  if (!Array.isArray(payload) || payload.length === 0) {
    throw new SourceProviderError('PROVIDER_INVALID_REQUEST', 'OpenStreetMap discovery could not resolve the search location.');
  }
  const box = (payload[0] as { boundingbox?: unknown }).boundingbox;
  if (!Array.isArray(box) || box.length !== 4) {
    throw new SourceProviderError('PROVIDER_UNKNOWN_ERROR', 'OpenStreetMap provider returned an invalid response.');
  }
  const [south, north, west, east] = box.map((value) => Number(value));
  if ([south, north, west, east].some((value) => !Number.isFinite(value)) || south >= north || west >= east) {
    throw new SourceProviderError('PROVIDER_UNKNOWN_ERROR', 'OpenStreetMap provider returned an invalid response.');
  }
  return { south, west, north, east };
}

function parseOverpassPayload(payload: unknown): OverpassResponse {
  if (!payload || typeof payload !== 'object') {
    throw new SourceProviderError('PROVIDER_UNKNOWN_ERROR', 'OpenStreetMap provider returned an invalid response.');
  }
  const body = payload as OverpassResponse;
  if (Array.isArray(body.elements)) return body;
  const remark = typeof body.remark === 'string' ? body.remark : '';
  if (/timed out|timeout/i.test(remark)) {
    throw new SourceProviderError('PROVIDER_TIMEOUT', 'OpenStreetMap provider request timed out.');
  }
  if (/parse error|syntax/i.test(remark)) {
    throw new SourceProviderError('PROVIDER_INVALID_REQUEST', 'OpenStreetMap provider rejected the search request.');
  }
  if (remark) {
    throw new SourceProviderError('PROVIDER_UNAVAILABLE', 'OpenStreetMap provider is unavailable.');
  }
  throw new SourceProviderError('PROVIDER_UNKNOWN_ERROR', 'OpenStreetMap provider returned an invalid response.');
}

function dedupeResults(results: NormalizedSourceResult[]): NormalizedSourceResult[] {
  const ranked = [...results].sort((left, right) => completeness(right) - completeness(left));
  const seen = new Set<string>();
  const unique: NormalizedSourceResult[] = [];
  for (const result of ranked) {
    const keys = [`osm:${result.externalId}`];
    if (result.website) keys.push(`website:${result.website}`);
    const phone = phoneMatchKey(result.phone);
    if (phone) keys.push(`phone:${phone}`);
    const city = result.address?.city?.trim().toLowerCase();
    const state = result.address?.state?.trim().toLowerCase();
    if (city && state) keys.push(`name:${result.name.trim().toLowerCase()}|${city}|${state}`);
    if (keys.some((key) => seen.has(key))) continue;
    keys.forEach((key) => seen.add(key));
    unique.push(result);
  }
  return unique;
}

function completeness(result: NormalizedSourceResult): number {
  return [result.website, result.phone, result.email, result.category, result.address?.addressLine1, result.address?.city].filter(Boolean).length;
}

function rawData(type: string, id: number, tags: Record<string, string>): Record<string, unknown> {
  const selected: Record<string, string> = {};
  for (const key of RAW_TAG_KEYS) {
    const value = tags[key];
    if (value && value.length <= 500) selected[key] = value;
  }
  return { provider: OSM_PROVIDER_NAME, source: 'openstreetmap', osmType: type, osmId: id, tags: selected };
}

function stringTags(tags: OverpassElement['tags']): Record<string, string> {
  if (!tags || typeof tags !== 'object') return {};
  const parsed: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags)) {
    if (typeof value === 'string') parsed[key] = value;
  }
  return parsed;
}

function categoryFrom(tags: Record<string, string>): string | undefined {
  for (const key of CATEGORY_KEYS) {
    const value = firstValue(tags[key]);
    if (!value || value.toLowerCase() === 'yes' || value.toLowerCase() === 'no') continue;
    return bounded(value.replaceAll('_', ' '), 100);
  }
  return undefined;
}

function streetLine(tags: Record<string, string>): string | undefined {
  const street = [firstValue(tags['addr:housenumber']), firstValue(tags['addr:street'])].filter(Boolean).join(' ');
  return bounded(street || firstValue(tags['addr:full']), 255);
}

function firstValue(value?: string): string | undefined {
  const first = value?.split(';')[0]?.trim();
  return first || undefined;
}

function twoLetterCountry(value?: string): string | undefined {
  if (!value || !/^[A-Za-z]{2}$/.test(value)) return undefined;
  return value.toUpperCase();
}

function finiteCoordinate(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function bounded(value: string | undefined, max: number): string | undefined {
  if (!value) return undefined;
  return value.length <= max ? value : undefined;
}

function httpsEndpoint(value: string | undefined): string | undefined {
  try {
    const parsed = new URL(value?.trim() || 'https://overpass-api.de/api/interpreter');
    return parsed.protocol === 'https:' ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
  return Number.isInteger(value) && (value as number) >= min && (value as number) <= max ? value as number : fallback;
}

function nonNegativeInt(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value as number) >= 0 ? value as number : fallback;
}

function delay(ms: number) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function discard(response: Response) {
  try {
    await response.text();
  } catch {
    return undefined;
  }
}
