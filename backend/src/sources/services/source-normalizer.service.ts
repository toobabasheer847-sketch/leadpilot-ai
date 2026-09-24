import { Injectable } from '@nestjs/common';
import { NormalizedSourceResult } from '../types/source.types';
import { SourceProviderError } from '../providers/source-provider.error';

@Injectable()
export class SourceNormalizerService {
  normalize(result: NormalizedSourceResult): NormalizedSourceResult {
    const normalized = {
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
    if (!normalized.externalId || !normalized.name || !normalized.sourceUrl) {
      throw new SourceProviderError('MALFORMED_RESPONSE', 'Provider result is missing required provenance fields.');
    }
    try {
      const sourceUrl = new URL(normalized.sourceUrl);
      if (!['http:', 'https:'].includes(sourceUrl.protocol)) throw new Error('unsupported protocol');
    } catch {
      throw new SourceProviderError('MALFORMED_RESPONSE', 'Provider result contains an invalid source URL.');
    }
    return normalized;
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
