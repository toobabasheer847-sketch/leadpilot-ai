import { render, screen } from '@testing-library/react';
import { LeadTable } from './LeadTable';

describe('lead empty state', () => {
  it('shows an empty message instead of demo leads', () => {
    render(<LeadTable leads={[]} />);
    expect(screen.getByRole('heading', { name: 'No leads found' })).toBeInTheDocument();
  });

  it('prints NOT_FOUND as Not Found and keeps VERIFIED only when returned', () => {
    render(<LeadTable leads={[{
      id: 'lead-1',
      company: { id: 'company-1', name: 'Stored Company', website: null, investorType: null, location: null },
      contact: { id: 'contact-1', name: null, title: 'FOUNDER', email: 'NOT_FOUND', phone: null },
      classification: null,
      score: null,
      verification: { status: 'SUPPORTED', field: 'email' },
      qualification: { status: 'NEEDS_REVIEW' },
      evidence: [],
      createdAt: '2026-01-01T00:00:00.000Z',
    }]} />);
    expect(screen.getAllByText('Not Found').length).toBeGreaterThan(0);
    expect(screen.getByText('SUPPORTED')).toBeInTheDocument();
    expect(screen.queryByText('VERIFIED')).not.toBeInTheDocument();
    expect(screen.getByText('Not available')).toBeInTheDocument();
  });
});
