import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('returns dependency statuses without dependency error details', async () => {
    const database = { ping: jest.fn().mockRejectedValue(new Error('database password=secret')) };
    const queue = { getJobCounts: jest.fn().mockRejectedValue(new Error('redis password=secret')) };
    const redis = { ping: jest.fn() };

    const result = await new HealthController(database as never, queue as never, redis as never).checkHealth();

    expect(result).toEqual(expect.objectContaining({
      status: 'degraded',
      services: {
        application: 'up',
        database: 'down',
        redis: 'down',
        queue: 'down',
      },
    }));
    expect(JSON.stringify(result)).not.toContain('secret');
  });
});
