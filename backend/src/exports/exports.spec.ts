import 'reflect-metadata';
import { ListLeadsDto } from '../leads/dto/list-leads.dto';
import { ExportFormatService } from './export-format.service';
import { applyExportMode, buildExportAuditMetadata, parseStoredExportFilters } from './export-mode';
import { columnsFromSearchPlan, displayHeaders } from './plan-export-columns';
import { sanitizeExportCell } from './sanitize-export-cell';
import { DEFAULT_EXPORT_FIELDS } from './types/export.types';
import type { SearchPlan } from '../search/types/search-plan.types';

describe('export formula injection sanitization', () => {
  it.each([
    ['=1+2', "'=1+2"],
    ['@SUM', "'@SUM"],
    ['-10', "'-10"],
    ['+cmd', "'+cmd"],
    ['\tTAB', "'\tTAB"],
    ['\rCR', "'\rCR"],
    ['safe', 'safe'],
  ])('escapes %j', (input, expected) => {
    expect(sanitizeExportCell(input, { missing: 'NOT_FOUND' })).toBe(expected);
  });
});

describe('plan-aware dynamic columns', () => {
  it('maps SearchPlan requested fields to export columns', () => {
    const plan: SearchPlan = {
      industry: ['software'],
      leadTypes: ['company'],
      locations: [],
      unresolvedCriteria: [],
      companyFields: ['companyWebsite', 'companyEmail'],
      personFields: ['personName', 'personTitle', 'personEmail', 'linkedin'],
      requiredFields: ['companyWebsite'],
      decisionMakerRoles: ['CEO'],
      socialPlatforms: ['linkedin'],
      emailRequirement: { requested: true, required: true, verified: true },
      websiteRequirement: { requested: true, required: true },
    };
    const columns = columnsFromSearchPlan(plan);
    expect(columns).toEqual(expect.arrayContaining([
      'companyName',
      'website',
      'companyEmail',
      'contactName',
      'contactTitle',
      'contactEmail',
      'decisionMakerLinkedin',
      'qualificationStatus',
      'qualificationReason',
      'score',
      'verificationStatus',
    ]));
    expect(displayHeaders(['companyName', 'website', 'contactEmail', 'score'])).toEqual([
      'Company Name',
      'Official Website',
      'Verified Email',
      'Lead Score',
    ]);
  });

  it('falls back to default columns when plan has no field bags', () => {
    const columns = columnsFromSearchPlan({
      industry: [],
      leadTypes: [],
      locations: [],
      unresolvedCriteria: [],
      companyFields: [],
    });
    expect(columns).toEqual(expect.arrayContaining(DEFAULT_EXPORT_FIELDS));
  });
});

describe('export mode filtering', () => {
  it('filters QUALIFIED exports by qualification status', () => {
    const filters = applyExportMode(Object.assign(new ListLeadsDto(), { searchExecutionId: '11111111-1111-1111-1111-111111111111' }), 'QUALIFIED');
    expect(filters.qualificationStatus).toBe('QUALIFIED');
    expect(filters.searchExecutionId).toBe('11111111-1111-1111-1111-111111111111');
  });

  it('filters VERIFIED_CONTACTS exports by verified contact flag', () => {
    const filters = applyExportMode(new ListLeadsDto(), 'VERIFIED_CONTACTS');
    expect(filters.hasVerifiedContact).toBe(true);
    expect(filters.qualificationStatus).toBeUndefined();
  });

  it('leaves ALL mode filters unchanged', () => {
    const filters = applyExportMode(new ListLeadsDto(), 'ALL');
    expect(filters.qualificationStatus).toBeUndefined();
    expect(filters.hasVerifiedContact).toBeUndefined();
  });
});

describe('organization isolation helpers', () => {
  it('keeps exportMode/missingValueMode out of lead filters when parsing stored filters', () => {
    const parsed = parseStoredExportFilters({
      searchExecutionId: '22222222-2222-2222-2222-222222222222',
      exportMode: 'QUALIFIED',
      missingValueMode: 'EMPTY',
      qualificationStatus: 'QUALIFIED',
    });
    expect(parsed.exportMode).toBe('QUALIFIED');
    expect(parsed.missingValueMode).toBe('EMPTY');
    expect(parsed.filters.searchExecutionId).toBe('22222222-2222-2222-2222-222222222222');
    expect((parsed.filters as Record<string, unknown>).exportMode).toBeUndefined();
  });
});

describe('export audit metadata', () => {
  it('records user, organization, execution, format, lead count, and timestamp', () => {
    const metadata = buildExportAuditMetadata({
      userId: 'user-1',
      organizationId: 'org-1',
      searchExecutionId: 'exec-1',
      exportFormat: 'csv',
      exportMode: 'QUALIFIED',
      leadCount: 42,
    });
    expect(metadata).toEqual(expect.objectContaining({
      userId: 'user-1',
      organizationId: 'org-1',
      searchExecutionId: 'exec-1',
      exportFormat: 'csv',
      exportMode: 'QUALIFIED',
      leadCount: 42,
    }));
    expect(typeof metadata.timestamp).toBe('string');
  });
});

describe('export formatting', () => {
  const service = new ExportFormatService();

  it('escapes CSV commas, quotes, and newlines', () => {
    const output = service.csv(['companyName'], [['ACME, "North"\nHoldings']]).toString('utf8');
    expect(output).toContain('Company Name');
    expect(output).toContain('"ACME, ""North""\nHoldings"');
  });

  it('protects CSV and XLSX values from formula injection', async () => {
    const lead = { company: { name: '=SUM(A1:A2)' } };
    const rows = service.toRows([lead], ['companyName']);
    expect(rows[0][0]).toBe("'=SUM(A1:A2)");
    const workbook = await service.xlsx(['companyName'], rows);
    expect(workbook.length).toBeGreaterThan(0);
  });

  it('includes the stored employee size in CSV and XLSX rows', async () => {
    const rows = service.toRows([
      { company: { companySize: 23 } },
      { company: { companySize: '11-50' } },
      { company: { companySize: 'CONFLICT' } },
      { company: { companySize: null } },
    ], ['companySize']);
    expect(rows).toEqual([['23'], ['11-50'], ['CONFLICT'], ['UNKNOWN']]);
    expect(DEFAULT_EXPORT_FIELDS).toEqual(expect.arrayContaining([
      'companyName', 'website', 'companyEmail', 'employeeCount', 'employeeRange', 'companySizeStatus',
      'contactEmail', 'decisionMakerX', 'companyLinkedin', 'qualificationStatus', 'qualificationReason', 'verificationStatus',
    ]));
    const csv = service.csv(['companySize'], rows).toString('utf8');
    expect(csv).toContain('23');
    expect(csv).toContain('11-50');
    expect(csv).toContain('CONFLICT');
    expect((await service.xlsx(['companySize'], rows)).length).toBeGreaterThan(0);
  });

  it('preserves unavailable values as NOT_FOUND by default', () => {
    const rows = service.toRows([{ company: { name: null } }], ['companyName', 'contactEmail']);
    expect(rows).toEqual([['NOT_FOUND', 'NOT_FOUND']]);
  });

  it('supports EMPTY missing-value mode', () => {
    const rows = service.toRows([{ company: { name: null } }], ['companyName', 'contactEmail'], 'EMPTY');
    expect(rows).toEqual([['', '']]);
  });

  it('exports qualification reason and lead score', () => {
    const rows = service.toRows([{
      company: { name: 'Acme' },
      score: { value: 88, band: 'HIGH' },
      qualification: {
        status: 'QUALIFIED',
        qualifiedReasons: ['Has verified CEO email'],
        disqualifiedReasons: [],
      },
    }], ['companyName', 'score', 'qualificationStatus', 'qualificationReason']);
    expect(rows[0]).toEqual(['Acme', '88', 'QUALIFIED', 'Has verified CEO email']);
  });
});
