import type { NormalizedSourceResult } from '../types/source.types';
import { SourceDiscoveryService } from './source-discovery.service';

function pendingCandidate(name: string): NormalizedSourceResult {
  return {
    externalId: `openrouter:${name}`,
    name,
    sourceUrl: `https://${name.toLowerCase().replace(/\s+/g, '')}.example/about`,
    rawData: {
      qualificationStatus: 'PENDING',
      openRouterFields: { companyName: name, website: null },
    },
  };
}

function createService() {
  const logger = { error: jest.fn(), warn: jest.fn(), info: jest.fn() };
  const service = new SourceDiscoveryService(
    {} as never,
    {} as never,
    [] as never,
    { normalize: jest.fn((value: NormalizedSourceResult) => value) } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    logger as never,
  );
  const persistence = service as unknown as {
    persistResults: (
      organizationId: string,
      executionId: string,
      provider: string,
      results: NormalizedSourceResult[],
      synthetic: boolean,
      context: { organizationId: string; searchExecutionId: string },
    ) => Promise<number>;
    upsertCompany: jest.Mock;
    companyAlreadyInExecution: jest.Mock;
    upsertSourceRecord: jest.Mock;
    createEvidence: jest.Mock;
  };
  persistence.upsertCompany = jest.fn().mockResolvedValue({ id: 'company-id' });
  persistence.companyAlreadyInExecution = jest.fn().mockResolvedValue(false);
  persistence.upsertSourceRecord = jest.fn().mockResolvedValue({ id: 'source-record-id' });
  persistence.createEvidence = jest.fn().mockResolvedValue(undefined);
  return { persistence, logger };
}

describe('OpenRouter pending candidate persistence', () => {
  it('supplies safe name and location defaults and keeps website nullable', async () => {
    const { persistence } = createService();
    const result = await persistence.persistResults(
      'org-id',
      'execution-id',
      'openrouter',
      [pendingCandidate('Texas Home Buyers')],
      false,
      { organizationId: 'org-id', searchExecutionId: 'execution-id' },
    );

    expect(result).toBe(1);
    expect(persistence.upsertCompany).toHaveBeenCalledWith('org-id', 'openrouter', expect.objectContaining({
      name: 'Texas Home Buyers',
      website: undefined,
      address: { state: 'Texas', country: 'US' },
    }));
    expect(persistence.upsertSourceRecord).toHaveBeenCalledWith(
      'org-id',
      'execution-id',
      'company-id',
      'openrouter',
      expect.any(Object),
      { organizationId: 'org-id', searchExecutionId: 'execution-id' },
    );
  });

  it('logs a failed candidate and continues persisting later candidates', async () => {
    const { persistence, logger } = createService();
    persistence.upsertCompany
      .mockRejectedValueOnce(new Error('database constraint violation'))
      .mockResolvedValueOnce({ id: 'saved-company-id' });
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const result = await persistence.persistResults(
        'org-id',
        'execution-id',
        'openrouter',
        [pendingCandidate('Failed Candidate'), pendingCandidate('Saved Candidate')],
        false,
        { organizationId: 'org-id', searchExecutionId: 'execution-id' },
      );

      expect(result).toBe(1);
      expect(persistence.upsertCompany).toHaveBeenCalledTimes(2);
      expect(logger.error).toHaveBeenCalledWith('discovery.candidate_persistence.failed', expect.objectContaining({
        provider: 'openrouter',
        error: 'database constraint violation',
      }));
      expect(consoleError).toHaveBeenCalledWith(
        '[OpenRouterPersistenceError]',
        expect.objectContaining({ message: 'database constraint violation' }),
      );
    } finally {
      consoleError.mockRestore();
    }
  });
});
