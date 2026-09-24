import { render, screen } from '@testing-library/react';
import { ResearchList } from './ResearchList';

describe('research status rendering', () => {
  it('shows the backend status without a percentage', () => {
    render(<ResearchList companyName="Stored Company" executions={[{
      id: 'research-1',
      companyId: 'company-1',
      status: 'QUEUED',
      pagesDiscovered: 0,
      pagesProcessed: 0,
      fieldsExtracted: 0,
      fieldsVerified: 0,
      conflictsFound: 0,
      startedAt: null,
      completedAt: null,
      failedAt: null,
      errorMessage: null,
    }]} />);
    expect(screen.getByText('QUEUED')).toBeInTheDocument();
    expect(screen.getByText('research-1')).toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });
});
