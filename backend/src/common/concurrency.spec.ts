import { AsyncSemaphore, clampConcurrency, mapWithConcurrency } from './concurrency';

describe('Phase L concurrency helpers', () => {
  it('clamps concurrency into a safe range', () => {
    expect(clampConcurrency(undefined, 4, 16)).toBe(4);
    expect(clampConcurrency(0, 4, 16)).toBe(4);
    expect(clampConcurrency(100, 4, 16)).toBe(16);
    expect(clampConcurrency(3, 4, 16)).toBe(3);
  });

  it('never exceeds the configured concurrency for 300 items', async () => {
    const items = Array.from({ length: 300 }, (_, index) => index);
    let inFlight = 0;
    let maxInFlight = 0;
    const started: number[] = [];

    const results = await mapWithConcurrency(items, 4, async (item) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      started.push(item);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return item * 2;
    }, { maxConcurrency: 16 });

    expect(results).toHaveLength(300);
    expect(results[0]).toBe(0);
    expect(results[299]).toBe(598);
    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(started).toHaveLength(300);
  });

  it('continues remaining items when the worker swallows per-item failures', async () => {
    const items = [1, 2, 3, 4, 5];
    const results = await mapWithConcurrency(items, 2, async (item) => {
      try {
        if (item === 3) throw new Error('company failed');
        return item;
      } catch {
        return null;
      }
    });
    expect(results).toEqual([1, 2, null, 4, 5]);
  });

  it('bounds AsyncSemaphore capacity', async () => {
    const gate = new AsyncSemaphore(2);
    let inFlight = 0;
    let maxInFlight = 0;
    await Promise.all(Array.from({ length: 20 }, () => gate.run(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
    })));
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(gate.running).toBe(0);
  });
});
