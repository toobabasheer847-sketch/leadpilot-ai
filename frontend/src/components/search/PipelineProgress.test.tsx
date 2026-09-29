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
    employeeSize: 'PENDING',
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
    companiesPersisted: 2,
    companiesProcessed: 2,
    requestedCount: 2,
    countIntent: 'exact',
    discoveryShortfall: 0,
    discoveryRejected: 1,
    discoveryDuplicatesRemoved: 0,
    discoveryProviderQueries: 3,
    discoveryProviderStatusSummary: null,
    discoveryProvidersAttempted: null,
    discoveryProvidersSucceeded: null,
    discoveryProvidersFailed: null,
    discoveryProvidersSkipped: null,
    discoveryQueriesSkipped: null,
    companySizeRequested: false,
    websitesFound: 1,
    websitesNotFound: 1,
    websitesResearched: 1,
    companySizeFound: null,
    companySizeUnknown: null,
    decisionMakersFound: null,
    decisionMakerEmailsFound: null,
    companyEmailsFound: null,
    socialProfilesFound: null,
    contactsFound: null,
    evidenceCollected: null,
    verifiedFields: null,
    conflictsFound: null,
    duplicatesFound: null,
    qualifiedLeads: null,
    qualifiedShortfall: null,
    needsReview: null,
    rejected: null,
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
    expect(screen.getAllByText('2').length).toBe(3);
    expect(screen.getByText('Requested count')).toBeInTheDocument();
    expect(screen.getByText('Count intent')).toBeInTheDocument();
    expect(screen.getByText('exact')).toBeInTheDocument();
    expect(screen.getByText('Companies discovered')).toBeInTheDocument();
    expect(screen.getByText('Company size requested')).toBeInTheDocument();
    expect(screen.getByText('No')).toBeInTheDocument();
    expect(screen.queryByText('Qualified leads')).not.toBeInTheDocument();
    expect(screen.queryByText('Qualified shortfall')).not.toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\d+%/);
  });

  it('distinguishes requested, qualified, and shortfall when present', () => {
    const done: PipelineView = {
      ...pipeline,
      status: 'COMPLETED',
      counters: {
        ...pipeline.counters,
        requestedCount: 100,
        countIntent: 'exact',
        companiesDiscovered: 90,
        companiesPersisted: 80,
        discoveryShortfall: 20,
        qualifiedLeads: 63,
        qualifiedShortfall: 37,
        needsReview: 10,
        rejected: 7,
      },
    };
    render(<MemoryRouter><PipelineProgress pipeline={done} /></MemoryRouter>);
    expect(screen.getByText('Qualified leads')).toBeInTheDocument();
    expect(screen.getByText('Qualified shortfall')).toBeInTheDocument();
    expect(screen.getByText(/Qualified 63 of 100 requested/)).toBeInTheDocument();
    expect(screen.getByText(/Found 80 credible companies out of 100 requested/)).toBeInTheDocument();
  });
});
