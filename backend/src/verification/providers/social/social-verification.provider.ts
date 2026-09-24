import { Injectable } from '@nestjs/common';
import type { VerificationInput, VerificationSignal } from '../../types/verification.types';
import type { VerificationProvider } from '../verification-provider.interface';

@Injectable()
export class SocialVerificationProvider implements VerificationProvider {
  async verify(input: VerificationInput): Promise<VerificationSignal> {
    if (!input.value) return { status: 'NOT_FOUND', verificationType: 'SOURCE_EVIDENCE', provider: 'local-social' };
    try {
      const host = new URL(input.value).hostname.toLowerCase();
      if (!['linkedin.com', 'www.linkedin.com', 'facebook.com', 'www.facebook.com', 'instagram.com', 'www.instagram.com', 'youtube.com', 'www.youtube.com', 'youtu.be'].includes(host)) throw new Error('Unsupported social host');
    } catch {
      return { status: 'INVALID', verificationType: 'SYNTAX_CHECK', provider: 'local-social' };
    }
    return { status: 'UNVERIFIED', verificationType: 'SOURCE_EVIDENCE', provider: 'local-social' };
  }
}
