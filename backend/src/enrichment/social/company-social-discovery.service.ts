import { Injectable } from '@nestjs/common';
import { WebsiteNormalizerService } from '../website/website-normalizer.service';

@Injectable()
export class CompanySocialDiscoveryService {
  constructor(private readonly normalizer: WebsiteNormalizerService) {}

  discover(html: string, baseUrl: string): string[] {
    const urls = new Set<string>();
    const matches = html.matchAll(/href=["']([^"']+)["']/gi);

    for (const match of matches) {
      const candidate = this.normalizeCandidate(match[1], baseUrl);
      if (!candidate) {
        continue;
      }
      const lower = candidate.toLowerCase();
      if (lower.includes('linkedin.com')) {
        urls.add(candidate);
      }
      if (lower.includes('facebook.com')) {
        urls.add(candidate);
      }
      if (lower.includes('instagram.com')) {
        urls.add(candidate);
      }
      if (lower.includes('youtube.com') || lower.includes('youtu.be')) {
        urls.add(candidate);
      }
      if (lower.includes('x.com') || lower.includes('twitter.com')) {
        urls.add(candidate);
      }
    }

    return Array.from(urls);
  }

  private normalizeCandidate(candidate: string, baseUrl: string): string | null {
    if (!candidate || candidate.startsWith('javascript:')) {
      return null;
    }

    try {
      const resolved = new URL(candidate, baseUrl);
      const host = resolved.hostname.toLowerCase();
      const allowed = ['linkedin.com', 'facebook.com', 'instagram.com', 'youtube.com', 'x.com', 'twitter.com', 'youtu.be'];
      if (!allowed.some((domain) => host === domain || host.endsWith(`.${domain}`))) {
        return null;
      }
      resolved.hash = '';
      const normalized = this.normalizer.normalizeUrl(resolved.toString());
      return normalized ?? null;
    } catch {
      return null;
    }
  }
}
