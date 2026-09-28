import { WebSearchError } from '../website/web-search.error';
import { assessEmployeeSize, collectEmployeeSizeEvidence, reconcileEmployeeSize, toEmployeeSizeEvidence, type EmployeeSizeFinding, type EmployeeSizePage } from './employee-size.collect';
import { extractEmployeeSize } from './employee-size.extract';
import { EmployeeSizeProcessor } from './employee-size.processor';
import type { EmployeeSizeService } from './employee-size.service';

const company = {
  name: 'Oak Stream Investors',
  website: 'https://oak.example/',
  city: 'Austin',
  state: 'Texas',
};

function page(text: string, url = 'https://oak.example/about', title = 'Oak Stream Investors'): EmployeeSizePage {
  return { url, title, text: `${title} in Austin, Texas. ${text}` };
}

function finding(normalized: string, url: string, sourceType: EmployeeSizeFinding['sourceType'] = 'official_company'): EmployeeSizeFinding {
  const value = extractEmployeeSize(`Company size: ${normalized} employees`);
  if (!value || value.kind === 'unusable') throw new Error(`Expected a normalized size for ${normalized}`);
  return {
    sourceUrl: url,
    sourceType,
    excerpt: value.excerpt,
    value,
    verified: sourceType === 'official_company',
    retrievedAt: '2026-09-27T00:00:00.000Z',
  };
}

describe('employee size evidence', () => {
  it('stores an exact count of 23, 1, 50, and 51 from page text', () => {
    expect(extractEmployeeSize('Oak Stream Investors has 23 employees')).toMatchObject({ kind: 'exact', count: 23 });
    expect(extractEmployeeSize('employees = 1')).toMatchObject({ kind: 'exact', count: 1 });
    expect(extractEmployeeSize('Oak Stream Investors has 50 employees')).toMatchObject({ kind: 'exact', count: 50 });
    expect(extractEmployeeSize('Oak Stream Investors has 51 employees')).toMatchObject({ kind: 'exact', count: 51 });
    expect(assessEmployeeSize(company, [page('Our team has 23 employees')])).toMatchObject({ outcome: 'value', employeeCount: 23, employeeRange: null });
    expect(assessEmployeeSize(company, [page('Our team has 1 employee')])).toMatchObject({ outcome: 'value', employeeCount: 1 });
    expect(assessEmployeeSize(company, [page('Our team has 50 employees')])).toMatchObject({ outcome: 'value', employeeCount: 50 });
    expect(assessEmployeeSize(company, [page('Our team has 51 employees')])).toMatchObject({ outcome: 'value', employeeCount: 51 });
  });

  it('stores bounded ranges and leaves overlapping or open-ended wording unconfirmed', () => {
    expect(assessEmployeeSize(company, [page('Company size: 1-10 employees')])).toMatchObject({ outcome: 'value', employeeCount: null, employeeRange: '1-10' });
    expect(assessEmployeeSize(company, [page('Company size: 11-50 employees')])).toMatchObject({ outcome: 'value', employeeRange: '11-50' });
    expect(assessEmployeeSize(company, [page('Company size: 51-200 employees')])).toMatchObject({ outcome: 'value', employeeRange: '51-200' });
    expect(assessEmployeeSize(company, [page('Company size: 1-200 employees')])).toMatchObject({ outcome: 'value', employeeRange: '1-200' });
    expect(extractEmployeeSize('Oak Stream Investors has 10+ employees')).toMatchObject({ kind: 'unusable' });
    expect(extractEmployeeSize('approximately 25 employees')).toMatchObject({ kind: 'unusable' });
    expect(extractEmployeeSize('We are a small company')).toMatchObject({ kind: 'unusable' });
    expect(extractEmployeeSize('3.3 Employee stealing from clients')).toBeNull();
    expect(extractEmployeeSize('Accounts 266 Employees 5 Advisory reps 3')).toMatchObject({ kind: 'exact', count: 5 });
    expect(assessEmployeeSize(company, [page('We are a small company')])).toMatchObject({ outcome: 'none', employeeCount: null, employeeRange: null, findings: [expect.objectContaining({ value: null })] });
    expect(assessEmployeeSize(company, [page('Welcome to our Austin office')])).toMatchObject({ outcome: 'none', employeeCount: null });
  });

  it('rejects a count that belongs to a different company and ignores search snippets', async () => {
    const mismatch = assessEmployeeSize(company, [{
      url: 'https://other.example/profile',
      title: 'Genesis Capital Partners',
      text: 'Genesis Capital Partners in Dallas, Texas has 23 employees.',
    }]);
    expect(mismatch.outcome).toBe('none');
    expect(mismatch.employeeCount).toBeNull();

    const similarName = assessEmployeeSize({ name: 'Falcon Holdings', city: null, state: null }, [{
      url: 'https://leadiq.com/c/falcon-holdings-management-llc/employee-directory',
      title: 'Falcon Holdings Management LLC',
      text: 'Falcon Holdings Management LLC. Employee Directory. Restaurants. United States. 51-200 Employees.',
    }]);
    expect(similarName).toMatchObject({ outcome: 'none', employeeCount: null, employeeRange: null });

    const unlabeledOffice = assessEmployeeSize({ name: 'Fidelity Investments', city: null, state: null, website: null }, [{
      url: 'https://en.wikipedia.org/wiki/Fidelity_Investments',
      title: 'Fidelity Investments',
      text: 'Fidelity Investments has 70000 employees.',
    }]);
    expect(unlabeledOffice).toMatchObject({ outcome: 'none', employeeCount: null, employeeRange: null });

    const labeledCount = assessEmployeeSize({
      name: 'Toro Bravo Investment Advisors',
      city: 'Amarillo',
      state: 'TX',
      website: 'https://torobravoadvisors.com',
    }, [{
      url: 'https://fintrx.com/firms/firm/toro-bravo-investment-advisors-llc-288435',
      title: 'Toro Bravo Investment Advisors',
      text: 'Toro Bravo Investment Advisors. Accounts 266 Employees 5 Advisory reps 3. Headquarters Amarillo, Texas.',
    }]);
    expect(labeledCount).toMatchObject({ outcome: 'value', employeeCount: 5, employeeRange: null });

    const search = jest.fn().mockResolvedValue([{
      title: 'Oak Stream Investors',
      url: 'https://oak.example/about',
      snippet: 'Oak Stream Investors in Austin, Texas has 23 employees',
      source: 'tavily',
      retrievedAt: '2026-09-27T00:00:00.000Z',
    }]);
    const fetchPage = jest.fn().mockResolvedValue({
      url: 'https://oak.example/about',
      title: 'Oak Stream Investors',
      text: 'Oak Stream Investors serves Austin, Texas.',
    });
    const ignored = await collectEmployeeSizeEvidence(company, { search, fetchPage });
    expect(ignored).toMatchObject({ outcome: 'none', employeeCount: null, employeeRange: null });
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ companyName: 'Oak Stream Investors', category: 'employees' }));
  });

  it('keeps source evidence and records a conflict instead of choosing one side', () => {
    const stored = assessEmployeeSize(company, [page('Company size: 11-50 employees', 'https://oak.example/about')]);
    expect(stored.findings).toHaveLength(1);
    expect(toEmployeeSizeEvidence('company-1', stored.findings[0])).toMatchObject({
      companyId: 'company-1',
      evidenceType: 'EMPLOYEE_SIZE',
      sourceUrl: 'https://oak.example/about',
      sourceType: 'official_company',
      evidenceText: expect.stringContaining('11-50'),
      verified: true,
      verificationStatus: 'VERIFIED',
      value: '11-50',
    });

    const directory = assessEmployeeSize(company, [{
      url: 'https://www.zoominfo.com/c/oak-stream-investors',
      title: 'Oak Stream Investors company profile',
      text: 'Oak Stream Investors company profile. Austin, Texas. Company size: 11-50 employees.',
    }]);
    expect(directory.findings[0]).toMatchObject({ sourceType: 'public_directory', verified: false });

    const conflict = reconcileEmployeeSize([
      finding('11-50', 'https://oak.example/about'),
      finding('51-200', 'https://directory.example/oak', 'public_directory'),
    ]);
    expect(conflict).toMatchObject({
      outcome: 'conflict',
      employeeCount: null,
      employeeRange: null,
      conflict: { valueA: '11-50', valueB: '51-200' },
    });
    expect(conflict.findings).toHaveLength(2);

    const contained = reconcileEmployeeSize([
      finding('11-50', 'https://oak.example/about'),
      finding('23', 'https://oak.example/team'),
    ]);
    expect(contained).toMatchObject({ outcome: 'value', employeeCount: 23, employeeRange: null });
  });

  it('reports provider configuration, timeout, rate limit, server, and malformed errors without inventing a count', async () => {
    const cases = [
      new WebSearchError('CONFIGURATION_ERROR', 'tavily', 'search', false, 'Web search provider is not configured.'),
      new WebSearchError('PROVIDER_TIMEOUT', 'tavily', 'search', true, 'Web search provider timed out.'),
      new WebSearchError('PROVIDER_RATE_LIMIT', 'tavily', 'search', true, 'Web search provider rate limit reached.'),
      new WebSearchError('PROVIDER_HTTP_ERROR', 'tavily', 'search', true, 'Web search provider returned HTTP 503.'),
      new WebSearchError('INVALID_PROVIDER_RESPONSE', 'tavily', 'search', false, 'Web search provider returned an invalid response.'),
    ];
    for (const error of cases) {
      await expect(collectEmployeeSizeEvidence(company, {
        search: async () => { throw error; },
        fetchPage: async () => null,
      })).rejects.toMatchObject({ errorCode: error.errorCode, retryable: error.retryable, message: error.message });
    }
  });

  it('continues when no employee-size evidence exists and does not retry a non-retryable search error', async () => {
    const empty = await collectEmployeeSizeEvidence({ name: 'Oak Stream Investors', city: 'Austin', state: 'Texas' }, {
      search: async () => [],
      fetchPage: async () => null,
    });
    expect(empty).toMatchObject({ outcome: 'none', employeeCount: null, employeeRange: null, findings: [] });

    const processor = new EmployeeSizeProcessor({ collect: async () => 'NOT_FOUND' } as EmployeeSizeService);
    await expect(processor.process({ data: { organizationId: 'org-1', companyId: 'company-1' } } as never)).resolves.toBe('NOT_FOUND');

    const failing = new EmployeeSizeProcessor({
      collect: async () => { throw new WebSearchError('CONFIGURATION_ERROR', 'tavily', 'search', false, 'Web search provider is not configured.'); },
    } as EmployeeSizeService);
    await expect(failing.process({ data: { organizationId: 'org-1', companyId: 'company-1' } } as never)).rejects.toThrow('Web search provider is not configured.');

    const retryable = new EmployeeSizeProcessor({
      collect: async () => { throw new WebSearchError('PROVIDER_HTTP_ERROR', 'tavily', 'search', true, 'Web search provider returned HTTP 503.'); },
    } as EmployeeSizeService);
    await expect(retryable.process({ data: { organizationId: 'org-1', companyId: 'company-1' } } as never)).rejects.toBeInstanceOf(WebSearchError);
  });
});
