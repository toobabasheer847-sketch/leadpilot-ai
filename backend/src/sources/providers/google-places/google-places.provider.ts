import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OutboundRequestService } from '../../../common/outbound-request.service';
import { SearchPlan } from '../../../search/types/search-plan.types';
import { GooglePlacesTextSearchResponse } from './google-places.types';
import { SourceProvider, SourceSearchContext, SourceSearchResult } from '../../types/source.types';
import { buildGooglePlacesQuery } from './google-places.query-builder';
import { SourceProviderError } from '../source-provider.error';

@Injectable()
export class GooglePlacesProvider implements SourceProvider {
  readonly name = 'google_places';
  private readonly apiKey?: string;
  private readonly maxPages: number;
  private readonly retainRawData: boolean;
  private readonly timeoutMs: number;
  private readonly baseUrl?: string;

  constructor(
    private readonly outbound: OutboundRequestService,
    configService: ConfigService,
  ) {
    this.apiKey = configService.get<string>('sourceProvider.googlePlacesApiKey');
    this.maxPages = configService.get<number>('sourceProvider.maxPages', 3);
    this.retainRawData = configService.get<boolean>('sourceProvider.retainRawData', true);
    this.timeoutMs = configService.get<number>('sourceProvider.timeoutMs', 10000);
    const configuredBaseUrl = configService.get<string>('sourceProvider.googlePlacesBaseUrl');
    try {
      const parsed = new URL(configuredBaseUrl ?? '');
      this.baseUrl = parsed.protocol === 'https:' ? parsed.toString() : undefined;
    } catch {
      this.baseUrl = undefined;
    }
  }

  getSourceType() { return this.name; }
  getProviderName() { return this.name; }

  async search(plan: SearchPlan, _context: SourceSearchContext): Promise<SourceSearchResult> {
    if (!this.apiKey || !this.baseUrl) {
      throw new SourceProviderError('NOT_CONFIGURED', 'Google Places provider is not configured.');
    }

    const results: SourceSearchResult['results'] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < this.maxPages; page += 1) {
      const response = await this.request(buildGooglePlacesQuery(plan), pageToken);
      results.push(...(response.places ?? []).map((place) => this.normalize(place)));
      pageToken = response.nextPageToken;
      if (!pageToken) break;
    }

    return { provider: this.name, results };
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
        body: JSON.stringify({ textQuery, ...(pageToken ? { pageToken } : {}) }),
      }, this.timeoutMs);
    } catch (error) {
      throw new SourceProviderError(error instanceof Error && /timed out/i.test(error.message) ? 'TIMEOUT' : 'NETWORK_ERROR', 'Google Places provider request failed.');
    }

    if (response.status === 429) throw new SourceProviderError('RATE_LIMITED', 'Google Places provider rate limit reached.');
    if (response.status === 401 || response.status === 403) throw new SourceProviderError('AUTHENTICATION', 'Google Places provider authentication failed.');
    if (response.status === 400) throw new SourceProviderError('INVALID_REQUEST', 'Google Places provider rejected the search request.');
    if (!response.ok) throw new SourceProviderError('PROVIDER_ERROR', 'Google Places provider request failed.');

    try {
      const payload: unknown = await response.json();
      if (!payload || typeof payload !== 'object' || ('places' in payload && !Array.isArray(payload.places))) throw new Error('invalid payload');
      return payload as GooglePlacesTextSearchResponse;
    } catch {
      throw new SourceProviderError('MALFORMED_RESPONSE', 'Google Places provider returned an invalid response.');
    }
  }

  private normalize(place: NonNullable<GooglePlacesTextSearchResponse['places']>[number]) {
    const components = place.addressComponents ?? [];
    const find = (type: string) => components.find((component) => component.types?.includes(type))?.longText;
    return {
      externalId: place.id ?? '',
      name: place.displayName?.text ?? 'Not Found',
      website: place.websiteUri,
      phone: place.nationalPhoneNumber,
      category: place.primaryTypeDisplayName?.text,
      sourceUrl: place.googleMapsUri ?? '',
      address: {
        addressLine1: place.formattedAddress,
        city: find('locality'),
        state: find('administrative_area_level_1'),
        postalCode: find('postal_code'),
        country: find('country'),
        latitude: place.location?.latitude,
        longitude: place.location?.longitude,
      },
      ...(this.retainRawData ? { rawData: place as Record<string, unknown> } : {}),
    };
  }
}
