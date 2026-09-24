import { Injectable } from '@nestjs/common';
import type { VerificationInput, VerificationSignal } from '../../types/verification.types';
import type { VerificationProvider } from '../verification-provider.interface';

@Injectable()
export class WebsiteVerificationProvider implements VerificationProvider {
  async verify(input: VerificationInput): Promise<VerificationSignal> {
    if (!input.value) return { status: 'NOT_FOUND', verificationType: 'SOURCE_EVIDENCE', provider: 'local-website' };
    try {
      const url = new URL(input.value);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported protocol');
    } catch {
      return { status: 'INVALID', verificationType: 'SYNTAX_CHECK', provider: 'local-website' };
    }
    return { status: 'UNVERIFIED', verificationType: 'DOMAIN_CHECK', provider: 'local-website' };
  }
}
