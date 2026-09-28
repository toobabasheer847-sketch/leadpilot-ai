import { ExportFormatService } from './export-format.service';
import { DEFAULT_EXPORT_FIELDS } from './types/export.types';

describe('export formatting', () => {
  const service = new ExportFormatService();

  it('escapes CSV commas, quotes, and newlines', () => {
    const output = service.csv(['companyName'], [['ACME, "North"\nHoldings']]).toString('utf8');
    expect(output).toBe('companyName\r\n"ACME, ""North""\nHoldings"\r\n');
  });

  it('protects CSV and XLSX values from formula injection', () => {
    const lead = { company: { name: '=SUM(A1:A2)' } };
    const rows = service.toRows([lead], ['companyName']);
    expect(rows[0][0]).toBe("'=SUM(A1:A2)");
    const workbook = service.xlsx(['companyName'], rows);
    expect(workbook.length).toBeGreaterThan(0);
  });

  it('includes the stored employee size in CSV and XLSX rows', () => {
    const rows = service.toRows([
      { company: { companySize: 23 } },
      { company: { companySize: '11-50' } },
      { company: { companySize: 'CONFLICT' } },
      { company: { companySize: null } },
    ], ['companySize']);
    expect(rows).toEqual([['23'], ['11-50'], ['CONFLICT'], ['UNKNOWN']]);
    expect(DEFAULT_EXPORT_FIELDS).toEqual(expect.arrayContaining(['companyName', 'website', 'companyEmail', 'employeeCount', 'employeeRange', 'companySizeStatus', 'contactEmail', 'decisionMakerX', 'companyLinkedin', 'qualificationStatus', 'verificationStatus']));
    const csv = service.csv(['companySize'], rows).toString('utf8');
    expect(csv).toContain('23');
    expect(csv).toContain('11-50');
    expect(csv).toContain('CONFLICT');
    expect(service.xlsx(['companySize'], rows).length).toBeGreaterThan(0);
  });

  it('preserves unavailable values as empty export cells', () => {
    const rows = service.toRows([{ company: { name: null } }], ['companyName', 'contactEmail']);
    expect(rows).toEqual([['NOT_FOUND', 'NOT_FOUND']]);
  });
});
