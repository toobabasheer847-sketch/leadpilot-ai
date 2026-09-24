import { Injectable } from '@nestjs/common';
import { WebsiteDiscoveryOutcome } from './website.types';
import { WebsiteFetchService } from './website-fetch.service';
import { WebsiteNormalizerService } from './website-normalizer.service';

@Injectable()
export class WebsiteDiscoveryService {
  constructor(
    private readonly normalizer: WebsiteNormalizerService,
    private readonly fetchService: WebsiteFetchService,
  ) {}

  async discover(existingWebsite: string | null | undefined, companyName?: string | null): Promise<WebsiteDiscoveryOutcome> {
    const normalized = this.normalizer.normalizeUrl(existingWebsite ?? null);
    if (!normalized) {
      return { website: null, status: 'NOT_FOUND', reason: companyName ? `No verified website found for ${companyName}.` : 'Website not found.' };
    }

    try {
      const page = await this.fetchService.fetchPage(normalized);
      return {
        website: normalized,
        status: 'FOUND',
        page: {
          url: normalized,
          finalUrl: page.finalUrl,
          title: page.title ?? null,
          description: page.description ?? null,
          canonicalUrl: page.canonicalUrl ?? null,
          ogTitle: null,
          ogUrl: null,
          content: page.body,
          contentType: page.contentType,
          statusCode: page.statusCode,
        },
      };
    } catch {
      return { website: normalized, status: 'INVALID', reason: 'Website could not be fetched safely.' };
    }
  }
}
