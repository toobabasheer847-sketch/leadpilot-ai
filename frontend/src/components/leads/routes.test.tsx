import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ToastProvider } from '../../feedback/toasts';
import { LeadDetailPage } from '../../pages/LeadDetailPage';
import { LeadsPage } from '../../pages/LeadsPage';

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
}

describe('lead routes', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows a sanitized error when the leads request fails', async () => {
    vi.stubGlobal('fetch', (input: RequestInfo) => {
      const url = String(input);
      if (url.includes('/search-executions')) return json({ data: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } });
      return json({ message: 'select failed at postgres' }, 500);
    });
    render(<ToastProvider><MemoryRouter><LeadsPage /></MemoryRouter></ToastProvider>);
    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to complete the request. Please try again.');
    expect(screen.queryByText(/postgres/i)).not.toBeInTheDocument();
  });

  it('shows the not-found message for a missing company', async () => {
    vi.stubGlobal('fetch', () => json({ message: 'Lead not found' }, 404));
    render(
      <ToastProvider>
        <MemoryRouter initialEntries={['/leads/missing']}>
          <Routes>
            <Route path="/leads/:companyId" element={<LeadDetailPage />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Lead not found');
    expect(screen.queryByText('Stored Company')).not.toBeInTheDocument();
  });

  it('loads company intelligence from the API and keeps a 404 on the detail route', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/companies/company-1/contacts')) {
        return json([{
          id: 'person-1', fullName: 'Stored Person', title: 'Manager', email: null, emailStatus: 'NOT_FOUND', phone: null, phoneStatus: 'NOT_FOUND',
          linkedinUrl: null, facebookUrl: null, instagramUrl: null, youtubeUrl: null, verificationStatus: 'SUPPORTED', evidenceSummary: { independentSources: 1 },
        }]);
      }
      if (url.includes('/companies/company-1/verification')) {
        return json({
          verificationStatus: 'CONFLICT', evidenceCount: 1, sourceCount: 1, requiresReview: true, lastVerifiedAt: null,
          fields: [{ fieldName: 'website', fieldValue: 'https://stored.example', status: 'SUPPORTED', verificationStatus: 'SUPPORTED', contactId: null, checkedAt: null, metadata: { independentSources: 1 } }],
          conflicts: [{ id: 'conflict-1', fieldName: 'title', valueA: 'Founder', valueB: 'Former CEO', sourceTypeA: null, sourceUrlA: 'https://stored.example/a', sourceTypeB: null, sourceUrlB: 'https://stored.example/b', status: 'NEEDS_REVIEW' }],
        });
      }
      if (url.includes('/companies/company-1/classification')) {
        return json({ decision: 'QUALIFIED', classification: 'QUALIFIED', confidence: 0.5, investorType: 'Real Estate Investor', category: 'REAL_ESTATE_INVESTOR', positiveEvidence: [{ evidenceId: 'evidence-1', reason: 'Stored reason' }] });
      }
      if (url.includes('/companies/company-1/research') && init?.method === 'POST') return json({ researchExecutionId: 'research-1', status: 'QUEUED' });
      if (url.includes('/companies/company-1/research')) return json([]);
      if (url.includes('/companies/company-1/evidence')) return json([]);
      if (url.includes('/companies/company-1')) {
        return json({ id: 'company-1', name: 'Stored Company', website: 'https://stored.example', description: null, category: null, investorType: null, investmentStrategy: null, propertyTypes: null, marketsServed: null, phone: null, email: null, verificationStatus: null, lastVerifiedAt: null, socialProfiles: { linkedin: null }, evidenceCount: 0 });
      }
      if (url.includes('/leads/missing')) return json({ message: 'Lead not found' }, 404);
      if (url.includes('/leads/company-1')) {
        return json({
          id: 'company-1',
          company: { id: 'company-1', name: 'Stored Company', website: 'https://stored.example', investorType: null, location: null },
          contact: null, classification: { decision: 'QUALIFIED', confidence: 0.5 }, score: null, verification: { status: 'SUPPORTED', field: 'website' }, qualification: { status: 'QUALIFIED' },
          evidence: [{ id: 'evidence-1', sourceUrl: 'https://stored.example/about', sourceType: 'WEBSITE', evidenceType: 'DESCRIPTION', excerpt: 'Stored excerpt', timestamp: '2026-01-02T00:00:00.000Z' }],
          createdAt: '2026-01-01T00:00:00.000Z',
        });
      }
      return json({ message: 'Not found' }, 404);
    });

    render(
      <ToastProvider>
        <MemoryRouter initialEntries={['/leads/company-1']}>
          <Routes>
            <Route path="/leads/:companyId" element={<LeadDetailPage />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>,
    );
    expect(await screen.findByText('Stored Person')).toBeInTheDocument();
    expect(screen.getByText(/Stored excerpt/)).toBeInTheDocument();
    expect(screen.getByText(/Founder/)).toBeInTheDocument();
    expect(screen.getByText(/Former CEO/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'No research history' })).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Research Again' })[0]);
    await user.click(screen.getByRole('button', { name: 'Start research' }));
    expect(await screen.findByText(/Research status: QUEUED/)).toBeInTheDocument();
  });
});
