import { EmailVerificationProvider } from './providers/email/email-verification.provider';
import { PhoneVerificationProvider } from './providers/phone/phone-verification.provider';
import { SocialVerificationProvider } from './providers/social/social-verification.provider';
import { WebsiteVerificationProvider } from './providers/website/website-verification.provider';
import { normalizeState } from './utils/location-normalizer';

describe('field-level verification providers', () => {
  it('validates email syntax without claiming ownership or deliverability', async () => {
    const provider = new EmailVerificationProvider();
    await expect(provider.verify({ field: 'email', value: 'bad-email', evidence: [] })).resolves.toMatchObject({ status: 'INVALID' });
    await expect(provider.verify({ field: 'email', value: 'john@example.test', evidence: [] })).resolves.toMatchObject({ status: 'UNVERIFIED', metadata: { ownershipVerified: false, deliverabilityVerified: false } });
  });

  it('returns NOT_FOUND instead of guessing a missing email or phone', async () => {
    await expect(new EmailVerificationProvider().verify({ field: 'email', value: null, evidence: [] })).resolves.toMatchObject({ status: 'NOT_FOUND' });
    await expect(new PhoneVerificationProvider().verify({ field: 'phone', value: null, evidence: [] })).resolves.toMatchObject({ status: 'NOT_FOUND' });
  });

  it('separates phone syntax from ownership evidence', async () => {
    await expect(new PhoneVerificationProvider().verify({ field: 'phone', value: '555-0100', evidence: [] })).resolves.toMatchObject({ status: 'UNVERIFIED' });
    await expect(new PhoneVerificationProvider().verify({ field: 'phone', value: '12', evidence: [] })).resolves.toMatchObject({ status: 'INVALID' });
  });

  it('accepts only supported public social hosts and never constructs URLs', async () => {
    await expect(new SocialVerificationProvider().verify({ field: 'linkedin', value: 'https://linkedin.com/in/john', evidence: [] })).resolves.toMatchObject({ status: 'UNVERIFIED' });
    await expect(new SocialVerificationProvider().verify({ field: 'linkedin', value: 'https://example.test/john', evidence: [] })).resolves.toMatchObject({ status: 'INVALID' });
  });

  it('checks website syntax without equating a plausible domain with ownership', async () => {
    await expect(new WebsiteVerificationProvider().verify({ field: 'website', value: 'https://example.test', evidence: [] })).resolves.toMatchObject({ status: 'UNVERIFIED' });
    await expect(new WebsiteVerificationProvider().verify({ field: 'website', value: 'example.test', evidence: [] })).resolves.toMatchObject({ status: 'INVALID' });
  });

  it('normalizes US state names while preserving source values outside the normalizer', () => {
    expect(normalizeState('Texas')).toBe('TX');
    expect(normalizeState('tx')).toBe('TX');
    expect(normalizeState('Unknown State')).toBe('Unknown State');
  });
});
