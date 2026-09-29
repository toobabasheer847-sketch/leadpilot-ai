/**
 * Bounded parallel map — never launches unbounded Promise.all over large collections.
 * Concurrency is clamped to [1, maxConcurrency].
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  options: { maxConcurrency?: number } = {},
): Promise<R[]> {
  const max = Math.max(1, options.maxConcurrency ?? 16);
  const limit = Math.max(1, Math.min(max, Math.trunc(concurrency) || 1));
  if (items.length === 0) return [];
  if (limit === 1 || items.length === 1) {
    const out: R[] = [];
    for (let index = 0; index < items.length; index += 1) {
      out.push(await worker(items[index], index));
    }
    return out;
  }

  const results: R[] = [];
  results.length = items.length;
  let nextIndex = 0;

  const runWorker = async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  };

  const runners = Array.from({ length: Math.min(limit, items.length) }, () => runWorker());
  await Promise.all(runners);
  return results;
}

/** Clamp a configured concurrency to a safe operational range. */
export function clampConcurrency(value: number | undefined, fallback: number, max = 16): number {
  if (!Number.isInteger(value) || (value as number) < 1) return Math.max(1, Math.min(max, fallback));
  return Math.max(1, Math.min(max, value as number));
}

/**
 * Simple async semaphore for in-process request bounding (e.g. website fetches).
 */
export class AsyncSemaphore {
  private active = 0;
  private peak = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error('AsyncSemaphore capacity must be a positive integer.');
    }
  }

  get running(): number {
    return this.active;
  }

  get maxRunning(): number {
    return this.peak;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.capacity) {
      this.active += 1;
      this.peak = Math.max(this.peak, this.active);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiters.push(() => {
        this.active += 1;
        this.peak = Math.max(this.peak, this.active);
        resolve();
      });
    });
  }

  private release() {
    this.active = Math.max(0, this.active - 1);
    const next = this.waiters.shift();
    if (next) next();
  }
}
