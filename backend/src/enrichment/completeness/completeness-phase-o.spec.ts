import { mapWithConcurrency } from '../../common/concurrency';
import { MetricsService } from '../../common/observability/metrics.service';
import { ConfigService } from '@nestjs/config';
import { assessCompanyCompleteness, assessmentNeedsRetry, type CompletenessSnapshot } from './completeness.assess';
import { CompletenessRetryService } from './completeness-retry.service';
import { MAX_COMPLETENESS_RETRIES_PER_COMPANY } from './completeness.types';
import { publicCompanyProfiles } from '../social/company-social-discovery.service';
import { PipelineStageRunner } from '../../pipeline/pipeline.runner';
import { initialProgress } from '../../pipeline/pipeline.progress';

function baseSnapshot(overrides: Partial<CompletenessSnapshot> = {}): CompletenessSnapshot {
  return {
    companyId: 'c1',
    organizationId: 'org-a',
    name: 'Oak Stream Investors',
    category: 'investments',
    website: null,
    phone: null,
    email: null,
    employeeCount: null,
    employeeRange: null,
    city: 'Austin',
    state: 'Texas',
    country: 'US',
    address: null,
    socialPlatforms: [],
    contacts: [],
    hasSizeEvidence: false,
    ...overrides,
  };
}

describe('Phase O field completeness', () => {
  it('A. assesses FOUND vs NOT_FOUND without treating FOUND as VERIFIED', () => {
    const assessment = assessCompanyCompleteness(baseSnapshot({
      website: 'https://oak.example/',
      phone: '512-555-0100',
      socialPlatforms: ['linkedin'],
    }), {
      targetType: 'QUALIFIED_LEADS',
      companyFields: ['website', 'phone', 'linkedin', 'facebook'],
      socialPlatforms: ['LinkedIn', 'Facebook'],
      decisionMakerRoles: ['CEO'],
      companySize: { min: 1, max: 50 },
      emailRequirement: { requested: true, required: true },
    });

    expect(assessment.fields.find((field) => field.field === 'website')?.state).toBe('FOUND');
    expect(assessment.fields.find((field) => field.field === 'phone')?.state).toBe('FOUND');
    expect(assessment.fields.find((field) => field.field === 'companyLinkedin')?.state).toBe('FOUND');
    expect(assessment.fields.find((field) => field.field === 'companyFacebook')?.state).toBe('NOT_FOUND');
    expect(assessment.fields.find((field) => field.field === 'website')?.state).not.toBe('VERIFIED');
    expect(assessment.needsWebsite).toBe(false);
    expect(assessment.needsCompanySocial).toBe(true);
    expect(assessment.needsDecisionMaker).toBe(true);
    expect(assessment.needsEmployeeSize).toBe(true);
    expect(assessmentNeedsRetry(assessment)).toBe(true);
  });

  it('B. company LinkedIn does not satisfy person LinkedIn and person email stays unverified until ownership', () => {
    const assessment = assessCompanyCompleteness(baseSnapshot({
      website: 'https://oak.example/',
      socialPlatforms: ['linkedin'],
      contacts: [{
        fullName: 'Ada Example',
        title: 'CEO',
        email: 'ada@oak.example',
        linkedinUrl: null,
        facebookUrl: null,
        instagramUrl: null,
        twitterUrl: null,
        verificationStatus: 'NOT_VERIFIED',
      }],
    }), {
      targetType: 'QUALIFIED_LEADS',
      socialPlatforms: ['LinkedIn'],
      decisionMakerRoles: ['CEO'],
      personFields: ['personLinkedin', 'personEmail'],
      emailRequirement: { requested: true, required: true },
    });

    expect(assessment.fields.find((field) => field.field === 'companyLinkedin')?.state).toBe('FOUND');
    expect(assessment.fields.find((field) => field.field === 'personLinkedin')?.state).toBe('NOT_FOUND');
    expect(assessment.fields.find((field) => field.field === 'personEmail')?.state).toBe('UNVERIFIED');
    expect(assessment.needsPersonSocial).toBe(true);
  });

  it('C. already-complete companies do not need a retry pass', () => {
    const assessment = assessCompanyCompleteness(baseSnapshot({
      website: 'https://oak.example/',
      phone: '512-555-0100',
      email: 'info@oak.example',
      employeeCount: 12,
      employeeRange: '1-50',
      hasSizeEvidence: true,
      socialPlatforms: ['linkedin', 'facebook'],
      contacts: [{
        fullName: 'Ada Example',
        title: 'CEO',
        email: 'ada@oak.example',
        linkedinUrl: 'https://www.linkedin.com/in/ada-example',
        facebookUrl: null,
        instagramUrl: null,
        twitterUrl: null,
        verificationStatus: 'VERIFIED',
      }],
    }), {
      targetType: 'COMPANIES',
      companyFields: ['website', 'phone'],
      socialPlatforms: ['LinkedIn', 'Facebook'],
    });
    expect(assessmentNeedsRetry(assessment)).toBe(false);
  });

  it('D. 300-company completeness assessment stays bounded and org-isolated', async () => {
    const companies = Array.from({ length: 300 }, (_, index) => baseSnapshot({
      companyId: `org-a-company-${index + 1}`,
      organizationId: 'org-a',
      website: index % 3 === 0 ? null : `https://c${index}.example/`,
      phone: index % 5 === 0 ? null : '512-555-0100',
      socialPlatforms: index % 4 === 0 ? [] : ['linkedin'],
    }));

    let maxInFlight = 0;
    let inFlight = 0;
    let retries = 0;
    const assessments = await mapWithConcurrency(companies, 8, async (snapshot) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      const assessment = assessCompanyCompleteness(snapshot, {
        targetType: 'COMPANIES',
        companyFields: ['website', 'phone', 'linkedin'],
        socialPlatforms: ['LinkedIn'],
      });
      if (assessmentNeedsRetry(assessment)) retries += 1;
      inFlight -= 1;
      expect(assessment.organizationId).toBe('org-a');
      expect(assessment.companyId.startsWith('org-a-')).toBe(true);
      return assessment;
    }, { maxConcurrency: 16 });

    expect(assessments).toHaveLength(300);
    expect(maxInFlight).toBeLessThanOrEqual(8);
    expect(retries).toBeGreaterThan(0);
    expect(retries).toBeLessThan(300);
    expect(MAX_COMPLETENESS_RETRIES_PER_COMPANY).toBe(1);
    expect(assessments.some((item) => item.organizationId === 'org-b')).toBe(false);
  });

  it('E. completeness retry reuses research pages, skips known website, isolates provider failures', async () => {
    const searchText = jest.fn()
      .mockResolvedValueOnce([{
        title: 'Oak Stream Investors',
        url: 'https://www.linkedin.com/company/oak-stream',
        snippet: 'Oak Stream Investors official page',
        source: 'tavily',
        retrievedAt: new Date().toISOString(),
      }])
      .mockRejectedValueOnce(new Error('provider timeout'));

    const researchContext = {
      getPages: jest.fn().mockResolvedValue([{
        url: 'https://oak.example/contact',
        finalUrl: 'https://oak.example/contact',
        content: '<p>Call 512-555-0199. Email hello@oak.example. Oak Stream Investors Austin.</p>',
        title: 'Contact',
        fetchedAt: new Date().toISOString(),
        sourceStage: 'enrichment',
      }]),
      mergePages: jest.fn(),
      recordSearchHits: jest.fn(),
      getSearchHits: jest.fn().mockResolvedValue([]),
      shouldSkipQuery: jest.fn().mockResolvedValue(false),
      markQueryIssued: jest.fn(),
      observeDuration: jest.fn(),
    };

    const companyRepository = {
      findCompanyWithLocation: jest.fn().mockResolvedValue({
        company: {
          id: 'c1',
          organizationId: 'org-a',
          name: 'Oak Stream Investors',
          website: 'https://oak.example/',
          phone: null,
          email: null,
          category: 'investments',
          employeeCount: null,
          employeeRange: null,
          verificationStatus: 'NOT_VERIFIED',
          description: null,
        },
        location: { city: 'Austin', state: 'Texas', country: 'US', addressLine1: null },
      }),
      findCompanyForOrganization: jest.fn().mockResolvedValue({
        id: 'c1',
        organizationId: 'org-a',
        name: 'Oak Stream Investors',
        website: 'https://oak.example/',
        phone: null,
        email: null,
      }),
      updateCompany: jest.fn(),
      getSocialProfiles: jest.fn().mockResolvedValue([]),
      upsertSocialProfile: jest.fn(),
    };

    const evidenceRepository = { persistEvidence: jest.fn().mockResolvedValue([]) };
    const parser = {
      parsePage: jest.fn().mockReturnValue({
        phone: '512-555-0199',
        publicEmail: 'hello@oak.example',
        evidence: [{
          field: 'phone',
          value: '512-555-0199',
          sourceUrl: 'https://oak.example/contact',
          evidenceExcerpt: '512-555-0199',
          retrievedAt: new Date().toISOString(),
          evidenceType: 'CONTACT_PAGE',
        }],
        description: null,
        investmentStrategy: null,
        marketsServed: [],
        propertyTypes: [],
        socialLinks: [],
        investmentSignals: [],
      }),
    };
    const discovery = { discover: jest.fn() };
    const socialDiscovery = {
      discover: jest.fn().mockReturnValue(['https://www.linkedin.com/company/oak-stream']),
      fromSearchHits: jest.fn().mockReturnValue(['https://www.facebook.com/oakstream']),
    };

    const service = new CompletenessRetryService(
      {
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              groupBy: jest.fn().mockResolvedValue([{ companyId: 'c1' }]),
              limit: jest.fn().mockResolvedValue([]),
            }),
            innerJoin: jest.fn().mockReturnValue({
              where: jest.fn().mockResolvedValue([]),
            }),
          }),
        }),
      } as never,
      companyRepository as never,
      evidenceRepository as never,
      discovery as never,
      parser as never,
      { fetchPage: jest.fn() } as never,
      socialDiscovery as never,
      researchContext as never,
      { collect: jest.fn().mockResolvedValue('NOT_FOUND') } as never,
      { discoverForCompany: jest.fn() } as never,
      new MetricsService(),
      { get: () => 4 } as ConfigService,
      { searchText } as never,
    );

    service.resetForTests();
    Object.assign(service, {
      loadPlan: async () => ({
        targetType: 'COMPANIES',
        companyFields: ['phone', 'email', 'facebook', 'linkedin'],
        socialPlatforms: ['LinkedIn', 'Facebook'],
      }),
      listCompanyIds: async () => ['c1'],
      loadSnapshot: async () => baseSnapshot({
        website: 'https://oak.example/',
        phone: null,
        email: null,
        socialPlatforms: [],
      }),
    });

    const stats = await service.runForExecution('org-a', 'exec-1');
    expect(stats.companiesAssessed).toBe(1);
    expect(stats.companiesRetried).toBe(1);
    expect(discovery.discover).not.toHaveBeenCalled();
    expect(companyRepository.updateCompany).toHaveBeenCalled();
    expect(researchContext.getPages).toHaveBeenCalled();
    expect(parser.parsePage).toHaveBeenCalled();
    expect(stats.providerFailures).toBeGreaterThanOrEqual(1);
    expect(MAX_COMPLETENESS_RETRIES_PER_COMPANY).toBe(1);

    const second = await service.runForExecution('org-a', 'exec-1');
    expect(second.companiesRetried).toBe(0);
  });

  it('F. metrics expose completeness counters without secrets', () => {
    const metrics = new MetricsService();
    metrics.increment('completeness_companies_assessed_total', { scope: 'execution' });
    metrics.increment('completeness_companies_retried_total', {});
    metrics.increment('completeness_fields_filled_total', {});
    metrics.observe('completeness_pass_duration_ms', 120, { scope: 'execution' });
    const output = metrics.toPrometheus();
    expect(output).toContain('completeness_companies_retried_total');
    expect(output).toContain('completeness_fields_filled_total');
    expect(output).not.toMatch(/redis:\/\/|api[_-]?key|password|secret/i);
  });

  it('G. identity protection rejects similarly named company social and person /in/ profiles', () => {
    const urls = publicCompanyProfiles('Oak Stream Investors', [
      { url: 'https://www.linkedin.com/company/oak-capital-group', title: 'Oak Capital Group', snippet: 'Oak Capital Group invests in real estate.' },
      { url: 'https://www.linkedin.com/company/oak-stream-investors', title: 'Oak Stream Investors', snippet: 'Oak Stream Investors buys houses in Texas.' },
      { url: 'https://www.linkedin.com/in/ada-example', title: 'Ada Example', snippet: 'CEO at Oak Stream Investors' },
    ]);
    expect(urls).toEqual(['https://www.linkedin.com/company/oak-stream-investors']);
    expect(urls.some((url) => url.includes('/in/'))).toBe(false);
  });

  it('H. pipeline invokes completeness once after post-enrichment before CONTACT_QUALITY', async () => {
    const completeness = {
      runForExecution: jest.fn().mockResolvedValue({
        companiesAssessed: 2,
        companiesRetried: 1,
        fieldsFilled: 3,
        searchesSkipped: 1,
        providerFailures: 0,
        durationMs: 12,
      }),
    };
    const jobs = {
      settle: jest.fn().mockResolvedValue({ state: 'COMPLETED' }),
    };
    const runner = new PipelineStageRunner(
      {
        listCompanyIds: jest.fn().mockResolvedValue(['c1', 'c2']),
        getSearchExecution: jest.fn().mockResolvedValue({ structuredPlan: { targetType: 'COMPANIES' } }),
      } as never,
      {} as never,
      { enqueueContactDiscovery: jest.fn().mockResolvedValue({ jobId: 'dm-1' }) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { enqueueTracked: jest.fn().mockResolvedValue('research-1') } as never,
      {} as never,
      { enqueue: jest.fn().mockResolvedValue({ id: 'size-1' }) } as never,
      jobs as never,
      { increment: jest.fn(), observe: jest.fn() } as never,
      completeness as never,
      { get: () => 4 } as ConfigService,
    );

    const progress = initialProgress();
    progress.jobs.deepResearch = ['r1'];
    progress.jobs.employeeSize = ['s1'];
    progress.jobs.decisionMakerDiscovery = ['d1'];
    progress.stages.deepResearch = 'RUNNING';
    progress.stages.employeeSize = 'RUNNING';
    progress.stages.decisionMakerDiscovery = 'RUNNING';

    const advanced = await runner.tick({
      id: 'pipeline-1',
      organizationId: 'org-a',
      searchId: 'search-1',
      searchExecutionId: 'exec-1',
      status: 'RUNNING',
      currentStage: 'DEEP_RESEARCH',
      stageProgress: progress,
      startedAt: null,
      completedAt: null,
      failedAt: null,
      errorCode: null,
      errorMessage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never, progress);

    expect(advanced.type).toBe('advance');
    if (advanced.type !== 'advance') return;
    expect(advanced.currentStage).toBe('CONTACT_QUALITY');
    expect(completeness.runForExecution).toHaveBeenCalledTimes(1);
    expect(completeness.runForExecution).toHaveBeenCalledWith('org-a', 'exec-1');
    expect(advanced.progress.metrics?.completenessPassDone).toBe(true);
    expect(advanced.progress.metrics?.completenessFieldsFilled).toBe(3);
    expect(advanced.progress.metrics?.completenessCompaniesRetried).toBe(1);

    completeness.runForExecution.mockClear();
    const again = await runner.tick({
      id: 'pipeline-1',
      organizationId: 'org-a',
      searchId: 'search-1',
      searchExecutionId: 'exec-1',
      status: 'RUNNING',
      currentStage: 'DEEP_RESEARCH',
      stageProgress: advanced.progress,
      startedAt: null,
      completedAt: null,
      failedAt: null,
      errorCode: null,
      errorMessage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never, advanced.progress);
    expect(again.type).toBe('advance');
    expect(completeness.runForExecution).not.toHaveBeenCalled();
  });

  it('I. does not fabricate missing fields when evidence is absent', () => {
    const assessment = assessCompanyCompleteness(baseSnapshot({
      name: 'Ghost Co',
      website: null,
      phone: null,
      email: null,
      socialPlatforms: [],
      contacts: [],
    }), {
      targetType: 'QUALIFIED_LEADS',
      companyFields: ['website', 'phone', 'email', 'linkedin'],
      socialPlatforms: ['LinkedIn', 'Facebook', 'Instagram'],
      decisionMakerRoles: ['CEO'],
      emailRequirement: { requested: true, required: true },
      companySize: { min: 1, max: 50 },
    });

    const enrichable = assessment.fields.filter((item) => item.requested && item.field !== 'companyName');
    for (const field of enrichable) {
      expect(['NOT_FOUND', 'UNKNOWN', 'NEEDS_REVIEW', 'UNVERIFIED']).toContain(field.state);
      expect(field.state).not.toBe('FOUND');
      expect(field.state).not.toBe('VERIFIED');
    }
    expect(assessment.missingRequested.length).toBeGreaterThan(0);
  });
});
