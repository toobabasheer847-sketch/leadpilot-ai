import { render, screen } from '@testing-library/react';
import { VerificationCard } from '../company/VerificationCard';
import { verificationStatusLabel } from '../feedback/States';
import { truthfulEmailVerificationStatus } from '../../lib/email-verification-label';

describe('Phase F email verification UI truthfulness', () => {
  it('never labels deliverability-only as Verified Email / ownership', () => {
    expect(truthfulEmailVerificationStatus('VERIFIED', {
      deliverabilityVerified: true,
      ownershipVerified: false,
      verificationKind: 'deliverability',
    })).toBe('DELIVERABILITY_VERIFIED');
    expect(verificationStatusLabel('DELIVERABILITY_VERIFIED')).toBe('Deliverability Verified');
    expect(verificationStatusLabel('DELIVERABILITY_VERIFIED')).not.toBe('Verified');

    render(<VerificationCard
      label="Email"
      value="ada@northwind.example"
      status="VERIFIED"
      evidenceCount={0}
      verifiedAt={null}
      metadata={{ deliverabilityVerified: true, ownershipVerified: false, verificationKind: 'deliverability' }}
    />);
    expect(screen.getByText('Deliverability Verified')).toBeInTheDocument();
    expect(screen.queryByText(/^Verified$/)).not.toBeInTheDocument();
    expect(screen.getByText(/ownership not proven/i)).toBeInTheDocument();
  });

  it('labels syntax and supported evidence truthfully', () => {
    expect(verificationStatusLabel(truthfulEmailVerificationStatus('UNVERIFIED', { verificationKind: 'syntax', ownershipVerified: false }))).toBe('Email Syntax Valid');
    expect(verificationStatusLabel(truthfulEmailVerificationStatus('SUPPORTED', { verificationKind: 'evidence_supported', ownershipVerified: false }))).toBe('Evidence Supported');
    expect(verificationStatusLabel(truthfulEmailVerificationStatus('VERIFIED', { ownershipVerified: true, verificationKind: 'ownership' }))).toBe('Person Ownership Verified');
  });
});
