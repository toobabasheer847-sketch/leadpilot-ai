import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OutboundRequestError, OutboundRequestService } from '../../../common/outbound-request.service';
import { SearchPlan } from '../../../search/types/search-plan.types';
import { GooglePlacesTextSearchResponse } from './google-places.types';
import { NormalizedSourceResult, SourceProvider, SourceSearchContext, SourceSearchResult } from '../../types/source.types';
import { buildGooglePlacesQuery } from './google-places.query-builder';
import { isRetryableProviderError, SourceProviderError } from '../source-provider.error';

const GOOGLE_MAX_PAGE_SIZE = 20;

@Injectable()
export class GooglePlacesProvider implements SourceProvider {
  readonly name = 'google_places';
  private readonly apiKey?: string;
  private readonly maxResults: number;
  private readonly pageSize: number;
  private readonly retainRawData: boolean;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retryDelayMs: number;
  private readonly baseUrl?: string;

  constructor(
    private readonly outbound: OutboundRequestService,
    configService: ConfigService,
  ) {
    this.apiKey = configService.get<string>('sourceProvider.googlePlacesApiKey');
    this.maxResults = positiveInt(configService.get<number>('sourceProvider.maxResults'), 60);
    this.pageSize = Math.min(GOOGLE_MAX_PAGE_SIZE, positiveInt(configService.get<number>('sourceProvider.pageSize'), 20));
    this.retainRawData = configService.get<boolean>('sourceProvider.retainRawData', true);
    this.timeoutMs = positiveInt(configService.get<number>('sourceProvider.timeoutMs'), 10000);
    this.retries = nonNegativeInt(configService.get<number>('sourceProvider.retries'), 2);
    this.retryDelayMs = nonNegativeInt(configService.get<number>('sourceProvider.retryDelayMs'), 250);
    const configuredBaseUrl = configService.get<string>('sourceProvider.googlePlacesBaseUrl');
    try {
      const parsed = new URL(configuredBaseUrl ?? '');
      this.baseUrl = parsed.protocol === 'https:' ? parsed.toString().replace(/\/$/, '') : undefined;
    } catch {
      this.baseUrl = undefined;
    }
  }

  providerName() { return this.name; }
  getProviderName() { return this.providerName(); }
  getSourceType() { return this.name; }
  metadata() { return { provider: this.name, sourceType: this.name, synthetic: false }; }
  health() {
    const configured = Boolean(this.apiKey && this.baseUrl);
    return { name: this.name, configured, enabled: configured };
  }

  search(plan: SearchPlan, context: SourceSearchContext) {
    return this.searchBusinesses(plan, context);
  }

  async searchBusinesses(plan: SearchPlan, _context: SourceSearchContext): Promise<SourceSearchResult> {
    if (!this.apiKey || !this.baseUrl) {
      throw new SourceProviderError('PROVIDER_NOT_CONFIGURED', 'Google Places provider is not configured.');
    }

    const results: NormalizedSourceResult[] = [];
    const maxPages = Math.ceil(this.maxResults / this.pageSize);
    let pageToken: string | undefined;
    for (let page = 0; page < maxPages && results.length < this.maxResults; page += 1) {
      const response = await this.requestWithRetry(buildGooglePlacesQuery(plan), pageToken);
      for (const place of response.places ?? []) {
        if (results.length >= this.maxResults) break;
        results.push(this.normalizeResult(place));
      }
      pageToken = response.nextPageToken;
      if (!pageToken) break;
    }

    return { provider: this.name, results };
  }

  normalizeResult(raw: unknown): NormalizedSourceResult {
    if (!raw || typeof raw !== 'object') {
      throw new SourceProviderError('PROVIDER_INVALID_REQUEST', 'Google Places provider returned an invalid response.');
    }
    const place = raw as NonNullable<GooglePlacesTextSearchResponse['places']>[number];
    const components = place.addressComponents ?? [];
    const find = (type: string) => components.find((component) => component.types?.includes(type))?.longText;
    const externalId = place.id?.trim() ?? '';
    const name = place.displayName?.text?.trim() ?? '';
    const sourceUrl = place.googleMapsUri?.trim() ?? '';
    if (!externalId || !name || !sourceUrl) {
      throw new SourceProviderError('PROVIDER_INVALID_REQUEST', 'Google Places provider returned a result without required provenance.');
    }
    return {
      externalId,
      name,
      website: place.websiteUri,
      phone: place.nationalPhoneNumber,
      category: place.primaryTypeDisplayName?.text,
      sourceUrl,
      address: {
        addressLine1: place.formattedAddress,
        city: find('locality'),
        state: find('administrative_area_level_1'),
        postalCode: find('postal_code'),
        country: find('country'),
        latitude: place.location?.latitude,
        longitude: place.location?.longitude,
      },
      ...(this.retainRawData ? { rawData: { provider: this.name, place } } : {}),
    };
  }

  private async requestWithRetry(textQuery: string, pageToken?: string): Promise<GooglePlacesTextSearchResponse> {
    let attempt = 0;
    for (;;) {
      try {
        return await this.request(textQuery, pageToken);
      } catch (error) {
        if (!isRetryableProviderError(error) || attempt >= this.retries) throw error;
        await delay(this.retryDelayMs * (2 ** attempt));
        attempt += 1;
      }
    }
  }

  private async request(textQuery: string, pageToken?: string): Promise<GooglePlacesTextSearchResponse> {
    let response: Response;
    try {
      response = await this.outbound.fetch(this.baseUrl as string, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': this.apiKey as string,
          'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.addressComponents,places.websiteUri,places.nationalPhoneNumber,places.primaryTypeDisplayName,places.googleMapsUri,places.location,nextPageToken',
        },
        body: JSON.stringify({ textQuery, pageSize: this.pageSize, ...(pageToken ? { pageToken } : {}) }),
      }, this.timeoutMs);
    } catch (error) {
      const timedOut = error instanceof OutboundRequestError && /timed out/i.test(error.message);
      throw new SourceProviderError(timedOut ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNAVAILABLE', timedOut ? 'Google Places provider request timed out.' : 'Google Places provider is unavailable.');
    }

    if (response.status === 429) throw await this.limitError(response);
    if (response.status === 401 || response.status === 403) throw new SourceProviderError('PROVIDER_AUTH_ERROR', 'Google Places provider authentication failed.');
    if (response.status === 400) throw new SourceProviderError('PROVIDER_INVALID_REQUEST', 'Google Places provider rejected the search request.');
    if (response.status >= 500) throw new SourceProviderError('PROVIDER_UNAVAILABLE', 'Google Places provider is unavailable.');
    if (!response.ok) throw new SourceProviderError('PROVIDER_UNKNOWN_ERROR', 'Google Places provider request failed.');

    try {
      const payload: unknown = await response.json();
      if (!payload || typeof payload !== 'object' || ('places' in payload && !Array.isArray(payload.places))) throw new Error('invalid payload');
      return payload as GooglePlacesTextSearchResponse;
    } catch (error) {
      if (error instanceof SourceProviderError) throw error;
      throw new SourceProviderError('PROVIDER_UNKNOWN_ERROR', 'Google Places provider returned an invalid response.');
    }
  }

  private async limitError(response: Response) {
    let quota = false;
    try {
      quota = /RESOURCE_EXHAUSTED|quota/i.test((await response.clone().text()).slice(0, 500));
    } catch {
      quota = false;
    }
    return new SourceProviderError(quota ? 'PROVIDER_QUOTA_EXCEEDED' : 'PROVIDER_RATE_LIMITED', quota ? 'Google Places provider quota was exceeded.' : 'Google Places provider rate limit reached.');
  }
}

function positiveInt(value: number | undefined, fallback: number) {
  return Number.isInteger(value) && (value as number) > 0 ? value as number : fallback;
}

function nonNegativeInt(value: number | undefined, fallback: number) {
  return Number.isInteger(value) && (value as number) >= 0 ? value as number : fallback;
}

function delay(ms: number) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
