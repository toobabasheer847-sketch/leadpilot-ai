import { ExportFormatService } from './export-format.service';

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

  it('preserves unavailable values as empty export cells', () => {
    const rows = service.toRows([{ company: { name: null } }], ['companyName', 'contactEmail']);
    expect(rows).toEqual([['', '']]);
  });
});
