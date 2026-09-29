import { Injectable } from '@nestjs/common';
import { classifyOfficialWebsiteHost } from '../../../enrichment/website/official-website.validator';
import type { VerificationInput, VerificationSignal } from '../../types/verification.types';
import type { VerificationProvider } from '../verification-provider.interface';

/**
 * Website verification:
 * - syntax / protocol check
 * - reject known social, directory, job-board, news, and marketplace hosts (never official websites)
 * - does not claim ownership without stronger evidence (conflict engine / discovery)
 */
@Injectable()
export class WebsiteVerificationProvider implements VerificationProvider {
  async verify(input: VerificationInput): Promise<VerificationSignal> {
    if (!input.value) return { status: 'NOT_FOUND', verificationType: 'SOURCE_EVIDENCE', provider: 'local-website' };
    let hostname = '';
    try {
      const url = new URL(input.value);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported protocol');
      hostname = url.hostname;
    } catch {
      return { status: 'INVALID', verificationType: 'SYNTAX_CHECK', provider: 'local-website' };
    }
    const hostReason = classifyOfficialWebsiteHost(hostname);
    if (hostReason) {
      return {
        status: 'INVALID',
        verificationType: 'DOMAIN_CHECK',
        provider: 'local-website',
        metadata: {
          ownershipVerified: false,
          rejectedHostReason: hostReason,
          hostValidated: true,
        },
      };
    }
    return {
      status: 'UNVERIFIED',
      verificationType: 'DOMAIN_CHECK',
      provider: 'local-website',
      metadata: { ownershipVerified: false, hostValidated: true },
    };
  }
}
