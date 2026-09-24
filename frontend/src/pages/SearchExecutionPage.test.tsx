import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ToastProvider } from '../feedback/toasts';
import { SearchExecutionPage } from './SearchExecutionPage';
import type { PipelineView } from '../types/api';
import { pipelineApi } from '../api/endpoints';

vi.mock('../api/endpoints', () => ({
  pipelineApi: { execution: vi.fn(), cancelExecution: vi.fn(), execute: vi.fn() },
  exportApi: { create: vi.fn() },
}));

const running: PipelineView = {
  pipelineExecutionId: 'pipeline-1',
  executionId: 'execution-1',
  searchId: 'search-1',
  searchExecutionId: 'execution-1',
  status: 'FAILED',
  currentStage: 'DISCOVERY',
  startedAt: '2026-01-01T00:00:00.000Z',
  completedAt: null,
  failedAt: '2026-01-01T00:01:00.000Z',
  stages: {
    search: 'COMPLETED', sourceDiscovery: 'FAILED', companyPersistence: 'PENDING', websiteDiscovery: 'PENDING',
    enrichment: 'PENDING', deepResearch: 'PENDING', decisionMakerDiscovery: 'PENDING', contactQuality: 'PENDING',
    evidence: 'PENDING', classification: 'PENDING', verification: 'PENDING', deduplication: 'PENDING', scoring: 'PENDING', qualification: 'PENDING',
  },
  stageList: [{ name: 'SEARCH', status: 'COMPLETED' }, { name: 'DISCOVERY', status: 'FAILED' }],
  counters: {
    companiesDiscovered: null, companiesProcessed: null, websitesResearched: null, decisionMakersFound: null,
    contactsFound: null, evidenceCollected: null, verifiedFields: null, conflictsFound: null, duplicatesFound: null, qualifiedLeads: null,
  },
  failures: [],
  error: { code: 'CONFIGURATION_ERROR', message: 'Search could not be completed.' },
};

describe('search execution page', () => {
  it('shows a safe failure message from backend state', async () => {
    vi.mocked(pipelineApi.execution).mockResolvedValue(running);
    render(
      <ToastProvider>
        <MemoryRouter initialEntries={['/search/search-1/execution/execution-1']}>
          <Routes>
            <Route path="/search/:searchId/execution/:executionId" element={<SearchExecutionPage />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>,
    );
    expect(await screen.findByRole('heading', { name: 'Search could not be completed' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Search could not be completed.');
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });
});
