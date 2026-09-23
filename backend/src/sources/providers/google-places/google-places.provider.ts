import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OutboundRequestService } from '../../../common/outbound-request.service';
import { SearchPlan } from '../../../search/types/search-plan.types';
import { GooglePlacesTextSearchResponse } from './google-places.types';
import { SourceProvider, SourceSearchContext, SourceSearchResult } from '../../types/source.types';
import { buildGooglePlacesQuery } from './google-places.query-builder';

export class SourceProviderError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = SourceProviderError.name;
  }
}

@Injectable()
export class GooglePlacesProvider implements SourceProvider {
  readonly name = 'google_places';
  private readonly apiKey?: string;
  private readonly maxPages: number;
  private readonly retainRawData: boolean;
  private readonly timeoutMs: number;

  constructor(
    private readonly outbound: OutboundRequestService,
    configService: ConfigService,
  ) {
    this.apiKey = configService.get<string>('sourceProvider.googlePlacesApiKey');
    this.maxPages = configService.get<number>('sourceProvider.maxPages', 3);
    this.retainRawData = configService.get<boolean>('sourceProvider.retainRawData', true);
    this.timeoutMs = configService.get<number>('sourceProvider.timeoutMs', 10000);
  }

  async search(plan: SearchPlan, _context: SourceSearchContext): Promise<SourceSearchResult> {
    if (!this.apiKey) {
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
    const response = await this.outbound.fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': this.apiKey as string,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.addressComponents,places.websiteUri,places.nationalPhoneNumber,places.primaryTypeDisplayName,places.googleMapsUri,places.location,nextPageToken',
      },
      body: JSON.stringify({ textQuery, ...(pageToken ? { pageToken } : {}) }),
    }, this.timeoutMs);

    if (response.status === 429) throw new SourceProviderError('RATE_LIMITED', 'Google Places provider rate limit reached.');
    if (response.status === 401 || response.status === 403) throw new SourceProviderError('AUTHENTICATION', 'Google Places provider authentication failed.');
    if (!response.ok) throw new SourceProviderError('PROVIDER_ERROR', 'Google Places provider request failed.');

    try {
      return await response.json() as GooglePlacesTextSearchResponse;
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
      sourceUrl: place.googleMapsUri ?? `https://www.google.com/maps/search/?api=1&query=place_id:${place.id ?? ''}`,
      address: {
        addressLine1: place.formattedAddress,
        city: find('locality'),
        state: find('administrative_area_level_1'),
        postalCode: find('postal_code'),
        country: find('country') ?? 'US',
        latitude: place.location?.latitude,
        longitude: place.location?.longitude,
      },
      ...(this.retainRawData ? { rawData: place as Record<string, unknown> } : {}),
    };
  }
}
