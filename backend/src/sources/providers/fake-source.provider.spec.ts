import { ConfigService } from '@nestjs/config';
import { FakeSourceProvider } from './fake-source.provider';

const plan = { industry: [], leadTypes: [], locations: [], companyFields: [], unresolvedCriteria: [] };

function provider(nodeEnv: string) {
  return new FakeSourceProvider({ get: (key: string) => (key === 'nodeEnv' ? nodeEnv : 'fake') } as ConfigService);
}

describe('FakeSourceProvider', () => {
  it('returns one marked test fixture outside production', async () => {
    const result = await provider('test').searchBusinesses(plan, { organizationId: 'org-1', searchExecutionId: 'execution-1' });
    expect(result.provider).toBe('fake_source');
    expect(result.results[0]?.rawData).toMatchObject({ synthetic: true, evidenceClass: 'TEST_ONLY' });
    expect(provider('test').metadata().synthetic).toBe(true);
  });

  it('refuses to run in production', async () => {
    await expect(provider('production').searchBusinesses(plan, { organizationId: 'org-1', searchExecutionId: 'execution-1' })).rejects.toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED' });
  });
});
