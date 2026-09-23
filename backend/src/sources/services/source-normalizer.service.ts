import { Injectable } from '@nestjs/common';
import { NormalizedSourceResult } from '../types/source.types';

@Injectable()
export class SourceNormalizerService {
  normalize(result: NormalizedSourceResult): NormalizedSourceResult {
    return {
      ...result,
      externalId: result.externalId.trim(),
      name: result.name.trim(),
      website: this.normalizeWebsite(result.website),
      phone: result.phone?.trim(),
      sourceUrl: result.sourceUrl.trim(),
      address: result.address ? {
        ...result.address,
        country: result.address.country?.toUpperCase(),
        state: result.address.state?.trim(),
        city: result.address.city?.trim(),
        postalCode: result.address.postalCode?.trim(),
      } : undefined,
    };
  }

  normalizeWebsite(website?: string) {
    if (!website) return undefined;
    try {
      const url = new URL(website);
      url.hash = '';
      url.pathname = url.pathname.replace(/\/$/, '');
      return url.toString().replace(/\/$/, '').toLowerCase();
    } catch {
      return website.trim().toLowerCase();
    }
  }
}
