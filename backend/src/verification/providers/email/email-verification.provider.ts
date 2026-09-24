import { Injectable } from '@nestjs/common';
import type { VerificationInput, VerificationSignal } from '../../types/verification.types';
import type { VerificationProvider } from '../verification-provider.interface';

@Injectable()
export class EmailVerificationProvider implements VerificationProvider {
  async verify(input: VerificationInput): Promise<VerificationSignal> {
    if (!input.value) return { status: 'NOT_FOUND', verificationType: 'SYNTAX_CHECK', provider: 'local-email' };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(input.value)) return { status: 'INVALID', verificationType: 'SYNTAX_CHECK', provider: 'local-email' };
    return { status: 'UNVERIFIED', verificationType: 'SYNTAX_CHECK', provider: 'local-email', metadata: { ownershipVerified: false, deliverabilityVerified: false } };
  }
}
