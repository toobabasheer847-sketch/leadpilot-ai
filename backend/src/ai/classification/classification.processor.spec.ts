import { UnrecoverableError } from 'bullmq';
import { ClassificationProcessor } from './classification.processor';
import { OpenRouterError } from './providers/openrouter.provider';

describe('ClassificationProcessor', () => {
  it('fails a non-retryable OpenRouter error without asking BullMQ to retry', async () => {
    const service = { classifyQueued: jest.fn().mockRejectedValue(new OpenRouterError('OpenRouter authentication failed (status 401)', 401, 'AUTHENTICATION', false)) };
    const processor = new ClassificationProcessor(service as never);
    await expect(processor.process({ data: {} } as never)).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('rethrows retryable OpenRouter errors for the queue retry policy', async () => {
    const error = new OpenRouterError('OpenRouter rate limit (status 429)', 429, 'RATE_LIMITED', true);
    const service = { classifyQueued: jest.fn().mockRejectedValue(error) };
    const processor = new ClassificationProcessor(service as never);
    await expect(processor.process({ data: {} } as never)).rejects.toBe(error);
  });
});
