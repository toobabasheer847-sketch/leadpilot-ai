import { CompanyEnrichmentProcessor } from './company-enrichment.processor';
import { PLAN_LIMIT_FALLBACK_MESSAGE } from './website/website-discovery.error';

describe('CompanyEnrichmentProcessor plan-limit fallback', () => {
  it('completes limited enrichment so pipeline persistence and later stages can continue', async () => {
    const where = jest.fn().mockResolvedValue(undefined);
    const set = jest.fn().mockReturnValue({ where });
    const db = { update: jest.fn().mockReturnValue({ set }) };
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const enrichment = {
      runCompanyEnrichment: jest.fn().mockRejectedValue(new Error('Web search provider plan limit exceeded.')),
    };
    const processor = new CompanyEnrichmentProcessor(
      enrichment as never,
      db as never,
      logger as never,
    );
    const job = {
      id: 'enrichment-job',
      data: {
        companyId: 'company-id',
        organizationId: 'organization-id',
        searchExecutionId: 'execution-id',
      },
    } as never;

    await expect(processor.process(job)).resolves.toMatchObject({
      companyId: 'company-id',
      organizationId: 'organization-id',
      websiteStatus: 'LIMITED',
      message: PLAN_LIMIT_FALLBACK_MESSAGE,
    });

    expect(db.update).toHaveBeenCalledTimes(2);
    expect(set).toHaveBeenNthCalledWith(1, expect.objectContaining({ status: 'RUNNING' }));
    expect(set).toHaveBeenNthCalledWith(2, expect.objectContaining({ status: 'COMPLETED' }));
    expect(logger.warn).toHaveBeenCalledWith(PLAN_LIMIT_FALLBACK_MESSAGE, expect.any(Object));
  });
});
