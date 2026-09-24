import { Injectable } from '@nestjs/common';
import type { VerificationInput, VerificationSignal } from '../../types/verification.types';
import type { VerificationProvider } from '../verification-provider.interface';

@Injectable()
export class PhoneVerificationProvider implements VerificationProvider {
  async verify(input: VerificationInput): Promise<VerificationSignal> {
    if (!input.value) return { status: 'NOT_FOUND', verificationType: 'SYNTAX_CHECK', provider: 'local-phone' };
    const digits = input.value.replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 15) return { status: 'INVALID', verificationType: 'SYNTAX_CHECK', provider: 'local-phone' };
    return { status: 'UNVERIFIED', verificationType: 'SYNTAX_CHECK', provider: 'local-phone', metadata: { ownershipVerified: false, type: 'UNKNOWN' } };
  }
}
