import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OutboundRequestError, OutboundRequestService } from '../../../common/outbound-request.service';
import type { VerificationInput, VerificationSignal } from '../../types/verification.types';
import type { VerificationProvider } from '../verification-provider.interface';
import { isGenericBusinessEmail } from '../../utils/generic-email';

/**
 * Email verification:
 * - syntax check always (syntax alone NEVER yields VERIFIED)
 * - generic mailboxes flagged as company-level only
 * - optional ZeroBounce deliverability when ZEROBOUNCE_API_KEY is configured
 * - ownershipVerified stays false unless a configured provider actually verifies ownership
 * Never performs SMTP mailbox probing. Never invents emails.
 */
@Injectable()
export class EmailVerificationProvider implements VerificationProvider {
  constructor(
    @Optional() private readonly config?: ConfigService,
    @Optional() private readonly outbound?: OutboundRequestService,
  ) {}

  async verify(input: VerificationInput): Promise<VerificationSignal> {
    if (!input.value) return { status: 'NOT_FOUND', verificationType: 'SYNTAX_CHECK', provider: 'local-email' };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(input.value)) {
      return { status: 'INVALID', verificationType: 'SYNTAX_CHECK', provider: 'local-email' };
    }

    const generic = isGenericBusinessEmail(input.value);
    if (generic) {
      return {
        status: 'UNVERIFIED',
        verificationType: 'SYNTAX_CHECK',
        provider: 'local-email',
        metadata: {
          ownershipVerified: false,
          deliverabilityVerified: false,
          genericMailbox: true,
          companyLevelOnly: true,
        },
      };
    }

    const zeroBounce = await this.verifyWithZeroBounce(input.value);
    if (zeroBounce) return zeroBounce;

    return {
      status: 'UNVERIFIED',
      verificationType: 'SYNTAX_CHECK',
      provider: 'local-email',
      metadata: { ownershipVerified: false, deliverabilityVerified: false, genericMailbox: false },
    };
  }

  private async verifyWithZeroBounce(email: string): Promise<VerificationSignal | null> {
    const apiKey = this.config?.get<string>('verification.zeroBounceApiKey')?.trim();
    if (!apiKey || !this.outbound) return null;
    const baseUrl = (this.config?.get<string>('verification.zeroBounceBaseUrl')?.trim() || 'https://api.zerobounce.net/v2').replace(/\/$/, '');
    const timeoutMs = this.config?.get<number>('verification.zeroBounceTimeoutMs', 10000) ?? 10000;
    try {
      const url = `${baseUrl}/validate?api_key=${encodeURIComponent(apiKey)}&email=${encodeURIComponent(email)}`;
      const response = await this.outbound.fetch(url, { method: 'GET' }, timeoutMs);
      if (response.status === 429 || response.status === 402) {
        return {
          status: 'UNVERIFIED',
          verificationType: 'PROVIDER_CHECK',
          provider: 'zerobounce',
          metadata: { ownershipVerified: false, deliverabilityVerified: false, providerLimited: true },
        };
      }
      if (!response.ok) return null;
      const payload = await response.json() as { status?: string; sub_status?: string };
      const status = (payload.status ?? '').toLowerCase();
      if (status === 'valid') {
        return {
          status: 'VERIFIED',
          verificationType: 'PROVIDER_CHECK',
          provider: 'zerobounce',
          confidence: 0.95,
          metadata: {
            ownershipVerified: false,
            deliverabilityVerified: true,
            zeroBounceStatus: payload.status,
            zeroBounceSubStatus: payload.sub_status ?? null,
          },
        };
      }
      if (status === 'invalid' || status === 'spamtrap' || status === 'abuse' || status === 'do_not_mail') {
        return {
          status: 'INVALID',
          verificationType: 'PROVIDER_CHECK',
          provider: 'zerobounce',
          metadata: {
            ownershipVerified: false,
            deliverabilityVerified: true,
            zeroBounceStatus: payload.status,
            zeroBounceSubStatus: payload.sub_status ?? null,
          },
        };
      }
      return {
        status: 'UNVERIFIED',
        verificationType: 'PROVIDER_CHECK',
        provider: 'zerobounce',
        metadata: {
          ownershipVerified: false,
          deliverabilityVerified: false,
          zeroBounceStatus: payload.status ?? 'unknown',
          zeroBounceSubStatus: payload.sub_status ?? null,
        },
      };
    } catch (error) {
      if (error instanceof OutboundRequestError) return null;
      return null;
    }
  }
}
