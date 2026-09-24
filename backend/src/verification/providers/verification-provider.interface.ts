import type { VerificationInput, VerificationSignal } from '../types/verification.types';

export const EMAIL_VERIFICATION_PROVIDER = Symbol('EMAIL_VERIFICATION_PROVIDER');
export const PHONE_VERIFICATION_PROVIDER = Symbol('PHONE_VERIFICATION_PROVIDER');
export const WEBSITE_VERIFICATION_PROVIDER = Symbol('WEBSITE_VERIFICATION_PROVIDER');
export const SOCIAL_VERIFICATION_PROVIDER = Symbol('SOCIAL_VERIFICATION_PROVIDER');

export interface VerificationProvider {
  verify(input: VerificationInput): Promise<VerificationSignal>;
}
