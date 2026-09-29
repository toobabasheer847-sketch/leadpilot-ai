import { Injectable } from '@nestjs/common';
import { isCompanyProfileUrl, isPersonProfileUrl } from '../../../contacts/discovery/public-decision-maker';
import type { VerificationInput, VerificationSignal } from '../../types/verification.types';
import type { VerificationProvider } from '../verification-provider.interface';

const SOCIAL_HOSTS = [
  'linkedin.com',
  'facebook.com',
  'instagram.com',
  'youtube.com',
  'youtu.be',
  'twitter.com',
  'x.com',
];

/**
 * Social verification validates host/shape only.
 * Never claims ownershipVerified — that requires independent evidence elsewhere.
 */
@Injectable()
export class SocialVerificationProvider implements VerificationProvider {
  async verify(input: VerificationInput): Promise<VerificationSignal> {
    if (!input.value) return { status: 'NOT_FOUND', verificationType: 'SOURCE_EVIDENCE', provider: 'local-social' };
    let host = '';
    try {
      host = new URL(input.value).hostname.toLowerCase().replace(/^www\./, '');
      if (!SOCIAL_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) {
        throw new Error('Unsupported social host');
      }
    } catch {
      return { status: 'INVALID', verificationType: 'SYNTAX_CHECK', provider: 'local-social' };
    }

    const person = isPersonProfileUrl(input.value);
    const company = isCompanyProfileUrl(input.value) || isLooseCompanySocial(input.value);
    const field = input.field.toLowerCase();
    const wantsPerson = /person|contact|linkedin|facebook|instagram|youtube|twitter|x/.test(field) && !/company/.test(field);
    // LinkedIn company field must be /company/; person LinkedIn must be /in/.
    if (host.endsWith('linkedin.com')) {
      if (/company/.test(field) && !company) {
        return {
          status: 'INVALID',
          verificationType: 'SYNTAX_CHECK',
          provider: 'local-social',
          metadata: { ownershipVerified: false, hostValidated: true, profileKind: person ? 'person' : 'unknown', reason: 'PERSON_PROFILE_NOT_COMPANY' },
        };
      }
      if (wantsPerson && field.includes('linkedin') && !person) {
        return {
          status: 'INVALID',
          verificationType: 'SYNTAX_CHECK',
          provider: 'local-social',
          metadata: { ownershipVerified: false, hostValidated: true, profileKind: company ? 'company' : 'unknown', reason: 'COMPANY_PROFILE_NOT_PERSON' },
        };
      }
    }

    return {
      status: 'UNVERIFIED',
      verificationType: 'SOURCE_EVIDENCE',
      provider: 'local-social',
      metadata: {
        ownershipVerified: false,
        hostValidated: true,
        profileKind: person ? 'person' : company ? 'company' : 'unknown',
      },
    };
  }
}

function isLooseCompanySocial(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length !== 1) return false;
    if (host.endsWith('linkedin.com')) return false;
    if (host.endsWith('youtube.com') || host === 'youtu.be') return parts[0].startsWith('@');
    if (host.endsWith('facebook.com') || host.endsWith('instagram.com') || host.endsWith('twitter.com') || host.endsWith('x.com')) {
      const segment = parts[0].toLowerCase();
      return !['share', 'sharer', 'login', 'search', 'intent', 'explore', 'watch', 'people', 'groups', 'status', 'posts', 'p', 'reel'].includes(segment);
    }
    return false;
  } catch {
    return false;
  }
}
