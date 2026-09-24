import { Injectable } from '@nestjs/common';

@Injectable()
export class WebsiteNormalizerService {
  normalizeUrl(input?: string | null): string | null {
    if (!input) {
      return null;
    }

    const trimmed = input.trim();
    if (!trimmed) {
      return null;
    }

    const candidate = /^https?:\/\//i.test(trimmed) || /^www\./i.test(trimmed) ? trimmed : `https://${trimmed}`;

    try {
      const parsed = new URL(candidate);
      if (!parsed.hostname) {
        return null;
      }

      parsed.hash = '';
      parsed.username = '';
      parsed.password = '';
      parsed.hostname = parsed.hostname.toLowerCase();

      if (parsed.hostname === 'www.' || parsed.hostname.startsWith('www.')) {
        parsed.hostname = parsed.hostname.replace(/^www\./i, '');
      }

      if ((parsed.protocol === 'http:' && parsed.port === '80') || (parsed.protocol === 'https:' && parsed.port === '443')) {
        parsed.port = '';
      }

      const parameters = new URLSearchParams();
      const trackingParams = new Set([
        'utm_source',
        'utm_medium',
        'utm_campaign',
        'utm_term',
        'utm_content',
        'gclid',
        'fbclid',
        'mc_cid',
        'mc_eid',
        'msclkid',
        'dclid',
        'igshid',
      ]);

      for (const [key, value] of parsed.searchParams.entries()) {
        if (!trackingParams.has(key.toLowerCase())) {
          parameters.append(key, value);
        }
      }

      parsed.search = parameters.toString();
      if (parsed.pathname === '') {
        parsed.pathname = '/';
      }

      if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
        parsed.pathname = parsed.pathname.replace(/\/+$/u, '/');
      }

      if (parsed.pathname === '/index.html') {
        parsed.pathname = '/';
      }

      return parsed.toString().replace(/\/$/u, '/');
    } catch {
      return null;
    }
  }

  isPublicWebsiteUrl(url: string): boolean {
    const normalized = this.normalizeUrl(url);
    if (!normalized) {
      return false;
    }

    try {
      const parsed = new URL(normalized);
      return ['http:', 'https:'].includes(parsed.protocol);
    } catch {
      return false;
    }
  }
}
