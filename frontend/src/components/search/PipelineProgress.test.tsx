import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PipelineProgress } from './PipelineProgress';
import type { PipelineView } from '../../types/api';

const pipeline: PipelineView = {
  pipelineExecutionId: 'pipeline-1',
  executionId: 'execution-1',
  searchId: 'search-1',
  searchExecutionId: 'execution-1',
  status: 'PARTIAL',
  currentStage: 'QUALIFICATION',
  startedAt: '2026-01-01T00:00:00.000Z',
  completedAt: null,
  failedAt: null,
  stages: {
    search: 'COMPLETED',
    sourceDiscovery: 'COMPLETED',
    companyPersistence: 'COMPLETED',
    websiteDiscovery: 'COMPLETED',
    enrichment: 'COMPLETED',
    deepResearch: 'PARTIAL',
    decisionMakerDiscovery: 'PENDING',
    contactQuality: 'PENDING',
    evidence: 'PENDING',
    classification: 'PENDING',
    verification: 'PENDING',
    deduplication: 'PENDING',
    scoring: 'PENDING',
    qualification: 'PENDING',
  },
  stageList: [
    { name: 'SEARCH', status: 'COMPLETED' },
    { name: 'DISCOVERY', status: 'COMPLETED' },
    { name: 'DEEP_RESEARCH', status: 'PARTIAL' },
    { name: 'QUALIFICATION', status: 'PENDING' },
  ],
  counters: {
    companiesDiscovered: 2,
    companiesProcessed: 2,
    websitesResearched: 1,
    decisionMakersFound: null,
    contactsFound: null,
    evidenceCollected: null,
    verifiedFields: null,
    conflictsFound: null,
    duplicatesFound: null,
    qualifiedLeads: null,
  },
  failures: [{ stage: 'DEEP_RESEARCH', message: 'One company could not be researched.' }],
  error: null,
};

describe('pipeline progress', () => {
  it('renders backend stage state and omits unknown counters', () => {
    render(<MemoryRouter><PipelineProgress pipeline={pipeline} /></MemoryRouter>);
    expect(screen.getByText('Search started')).toBeInTheDocument();
    expect(screen.getByText('Discovery')).toBeInTheDocument();
    expect(screen.getByText('Website research')).toBeInTheDocument();
    expect(screen.getAllByText('2').length).toBe(2);
    expect(screen.getByText('Companies discovered')).toBeInTheDocument();
    expect(screen.queryByText('Qualified leads')).not.toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\d+%/);
  });
});
