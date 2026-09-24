import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { LeadTable } from './LeadTable';
import type { LeadRecord } from '../../types/api';

const lead: LeadRecord = {
  id: 'company-1',
  company: { id: 'company-1', name: 'Stored Company', website: null, investorType: null, location: null },
  contact: { id: 'contact-1', name: null, title: 'FOUNDER', email: 'NOT_FOUND', phone: null },
  classification: null,
  score: null,
  verification: { status: 'SUPPORTED', field: 'email' },
  qualification: { status: 'NEEDS_REVIEW' },
  evidence: [],
  createdAt: '2026-01-01T00:00:00.000Z',
};

function LocationProbe() {
  const location = useLocation();
  return <span>{location.pathname}</span>;
}

describe('lead table', () => {
  it('shows an empty message instead of demo leads', () => {
    render(<LeadTable leads={[]} />);
    expect(screen.getByRole('heading', { name: 'No leads found' })).toBeInTheDocument();
  });

  it('prints NOT_FOUND as Not Found and keeps the returned verification status', () => {
    render(<MemoryRouter><LeadTable leads={[lead]} /></MemoryRouter>);
    expect(screen.getAllByText('Not Found').length).toBeGreaterThan(0);
    expect(screen.getByText('SUPPORTED')).toBeInTheDocument();
    expect(screen.queryByText('VERIFIED')).not.toBeInTheDocument();
    expect(screen.getAllByText('Not available').length).toBeGreaterThan(0);
    expect(screen.getByText('NEEDS_REVIEW')).toBeInTheDocument();
  });

  it('selects only the current page and opens the company route', async () => {
    const user = userEvent.setup();
    const onTogglePage = vi.fn();
    render(
      <MemoryRouter initialEntries={['/leads']}>
        <Routes>
          <Route path="/leads" element={<><LeadTable leads={[lead]} onTogglePage={onTogglePage} /><LocationProbe /></>} />
          <Route path="/leads/:companyId" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('checkbox', { name: 'Select all leads on this page' }));
    expect(onTogglePage).toHaveBeenCalledWith(['company-1'], true);
    await user.click(screen.getByRole('link', { name: 'Stored Company' }));
    expect(screen.getByText('/leads/company-1')).toBeInTheDocument();
  });
});
