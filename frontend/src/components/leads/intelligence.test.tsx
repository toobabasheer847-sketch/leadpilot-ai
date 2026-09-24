import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConflictPanel } from '../company/ConflictPanel';
import { DecisionMakerCard } from '../company/DecisionMakerCard';
import { EvidencePanel } from '../company/EvidencePanel';
import { ResearchHistory } from '../company/ResearchHistory';
import { VerificationCard } from '../company/VerificationCard';
import { ExportButton } from './ExportButton';
import { EmptyState } from '../feedback/States';

describe('company intelligence presentation', () => {
  it('renders a decision maker without inventing an email', () => {
    render(<DecisionMakerCard person={{
      id: 'person-1',
      fullName: null,
      title: null,
      email: 'NOT_FOUND',
      emailStatus: 'UNVERIFIED',
      phone: null,
      phoneStatus: 'NOT_FOUND',
      linkedinUrl: null,
      facebookUrl: null,
      instagramUrl: null,
      youtubeUrl: null,
      verificationStatus: 'UNVERIFIED',
      evidenceSummary: { independentSources: 2 },
    }} />);
    expect(screen.getAllByText('Not Found').length).toBeGreaterThan(0);
    expect(screen.getAllByText('UNVERIFIED').length).toBeGreaterThan(0);
    expect(screen.queryByText(/@/)).not.toBeInTheDocument();
    expect(screen.queryByText('VERIFIED')).not.toBeInTheDocument();
    expect(screen.getByText('Evidence count 2')).toBeInTheDocument();
  });

  it('shows both conflict values and does not choose a winner', () => {
    render(<ConflictPanel conflicts={[{
      id: 'conflict-1',
      fieldName: 'title',
      valueA: 'Founder',
      valueB: 'Former CEO',
      sourceTypeA: 'WEBSITE',
      sourceUrlA: 'https://stored.example/a',
      sourceTypeB: 'PROFILE',
      sourceUrlB: 'https://stored.example/b',
      status: 'NEEDS_REVIEW',
    }]} />);
    expect(screen.getByText(/Founder/)).toBeInTheDocument();
    expect(screen.getByText(/Former CEO/)).toBeInTheDocument();
    expect(screen.getByText('NEEDS_REVIEW')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'https://stored.example/a' })).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.queryByRole('button', { name: /winner|use this|select source/i })).not.toBeInTheDocument();
  });

  it('renders evidence and empty states', async () => {
    const user = userEvent.setup();
    render(<EvidencePanel evidence={[{
      id: 'evidence-1',
      sourceType: 'WEBSITE',
      evidenceType: 'DESCRIPTION',
      sourceUrl: 'https://stored.example/about',
      excerpt: 'Stored excerpt',
      timestamp: '2026-01-02T00:00:00.000Z',
    }]} />);
    await user.click(screen.getByRole('button', { name: /WEBSITE/ }));
    expect(screen.getByText('Stored excerpt')).toBeInTheDocument();
    render(<EvidencePanel evidence={[]} />);
    render(<ResearchHistory rows={[]} />);
    render(<ConflictPanel conflicts={[]} />);
    render(<VerificationCard label="Email" value={null} status="NOT_FOUND" evidenceCount={null} verifiedAt={null} />);
    render(<EmptyState title="No decision makers found" detail="None stored." />);
    expect(screen.getByRole('heading', { name: 'No evidence available' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'No research history' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'No conflicts reported' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'No decision makers found' })).toBeInTheDocument();
    expect(screen.getAllByText('Not Found').length).toBeGreaterThan(0);
  });
});

describe('export action', () => {
  it('reports creation and download only from the supplied callbacks', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    const onDownload = vi.fn();
    const { rerender } = render(<ExportButton phase="idle" onCreate={onCreate} onDownload={onDownload} />);
    await user.click(screen.getByRole('button', { name: 'CSV' }));
    expect(onCreate).toHaveBeenCalledWith('csv');
    rerender(<ExportButton phase="creating" onCreate={onCreate} onDownload={onDownload} />);
    expect(screen.getByText('Creating export...')).toBeInTheDocument();
    rerender(<ExportButton phase="ready" onCreate={onCreate} onDownload={onDownload} />);
    expect(screen.getByText('Export ready')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Download' }));
    expect(onDownload).toHaveBeenCalledOnce();
  });
});
