import { render, screen } from '@testing-library/react';
import { ContactCard } from '../company/ContactCard';
import { verificationStatusLabel } from '../feedback/States';
import { truthfulEmailVerificationStatus } from '../../lib/email-verification-label';

describe('Phase J email verification UI contract', () => {
  it('never collapses email statuses to generic Verified on ContactCard', () => {
    const statuses = [
      ['SYNTAX_VALID', 'Email Syntax Valid'],
      ['EVIDENCE_SUPPORTED', 'Evidence Supported'],
      ['EVIDENCE_VERIFIED', 'Evidence Verified'],
      ['DELIVERABILITY_VERIFIED', 'Deliverability Verified'],
      ['PERSON_OWNERSHIP_VERIFIED', 'Person Ownership Verified'],
    ] as const;

    for (const [status, label] of statuses) {
      expect(verificationStatusLabel(status)).toBe(label);
      expect(verificationStatusLabel(status)).not.toBe('Verified');
    }

    expect(truthfulEmailVerificationStatus('VERIFIED')).toBe('EVIDENCE_VERIFIED');
    expect(truthfulEmailVerificationStatus('SUPPORTED')).toBe('EVIDENCE_SUPPORTED');
    expect(truthfulEmailVerificationStatus('valid' as string)).not.toBe('PERSON_OWNERSHIP_VERIFIED');

    render(<ContactCard email="ada@northwind.example" emailStatus="VERIFIED" phone={null} phoneStatus={null} />);
    expect(screen.getByText('Evidence Verified')).toBeInTheDocument();
    expect(screen.queryByText(/^Verified$/)).not.toBeInTheDocument();
  });

  it('keeps deliverability distinct from ownership on ContactCard', () => {
    render(<ContactCard
      email="ada@northwind.example"
      emailStatus="DELIVERABILITY_VERIFIED"
      phone={null}
      phoneStatus={null}
    />);
    expect(screen.getByText('Deliverability Verified')).toBeInTheDocument();
    expect(screen.queryByText(/^Verified$/)).not.toBeInTheDocument();
    expect(screen.queryByText('Person Ownership Verified')).not.toBeInTheDocument();
  });
});
