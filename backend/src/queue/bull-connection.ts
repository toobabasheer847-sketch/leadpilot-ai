import type { WorkerOptions } from 'bullmq';
import { redisEndpoint } from '../redis/redis-endpoint';

export const BULL_DEFAULT_JOB_OPTIONS = {
  removeOnComplete: 50,
  removeOnFail: 100,
};

/** Shared BullMQ connection settings. Local `localhost` is pinned to IPv4. */
export function bullConnectionOptions(redisUrl: string) {
  return {
    ...redisEndpoint(redisUrl),
    maxRetriesPerRequest: null as null,
    connectTimeout: 10_000,
    retryStrategy(times: number) {
      if (isRedisShutdown()) return null;
      return Math.min(times * 500, 5_000);
    },
  };
}

/**
 * Keeps a long job's lock alive on Redis 5.
 * Renewal runs well before the lock expires. No Redis 6 stream commands are required.
 */
export const LONG_RUNNING_WORKER: Pick<WorkerOptions, 'lockDuration' | 'lockRenewTime' | 'stalledInterval' | 'maxStalledCount'> = {
  lockDuration: 300_000,
  lockRenewTime: 15_000,
  stalledInterval: 30_000,
  maxStalledCount: 2,
};

const SHUTDOWN_CODES = new Set(['ECONNRESET', 'EPIPE', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTCONN', 'ECONNABORTED']);

export function isShutdownConnectionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = 'code' in error && (error as { code?: unknown }).code != null ? String((error as { code?: unknown }).code) : '';
  if (SHUTDOWN_CODES.has(code)) return true;
  const message = error instanceof Error ? error.message : '';
  return /ECONNRESET|ECONNREFUSED|Connection is closed|Socket closed|connect ETIMEDOUT|write EPIPE/i.test(message);
}

let shutdownDepth = 0;
let shutdownResets = 0;

export function enterRedisShutdown() {
  shutdownDepth += 1;
}

export function leaveRedisShutdown() {
  shutdownDepth = Math.max(0, shutdownDepth - 1);
}

export function isRedisShutdown() {
  return shutdownDepth > 0;
}

export function noteShutdownReset() {
  shutdownResets += 1;
}

export function takeShutdownResetCount() {
  const count = shutdownResets;
  shutdownResets = 0;
  return count;
}

type RedisLike = {
  status?: string;
  options?: { retryStrategy?: ((times: number) => number | null | undefined) | null };
  disconnect?: (reconnect?: boolean) => void;
  stream?: { destroy?: () => void; destroyed?: boolean } | null;
  once?: (event: string, listener: () => void) => void;
  reconnectTimeout?: ReturnType<typeof setTimeout> | null;
};

type BullBackend = {
  connection?: { _client?: RedisLike };
  blockingConnection?: { _client?: RedisLike };
};

export type BullResource = {
  close?: (force?: boolean) => Promise<void>;
  getBackend?: () => unknown;
  on?: (event: 'error', listener: (error: Error) => void) => void;
  listenerCount?: (event: 'error') => number;
  isRunning?: () => boolean;
};

export function bullRedisClients(resource: BullResource): RedisLike[] {
  const backend = resource.getBackend?.() as BullBackend | undefined;
  if (!backend) return [];
  return [backend.connection?._client, backend.blockingConnection?._client].filter((client): client is RedisLike => Boolean(client));
}

export function sealRedisClient(client: RedisLike | null | undefined) {
  if (client?.options) client.options.retryStrategy = () => null;
}

function destroySocket(client: RedisLike) {
  if (client.reconnectTimeout) {
    clearTimeout(client.reconnectTimeout);
    client.reconnectTimeout = null;
  }
  if (client.stream && !client.stream.destroyed) client.stream.destroy?.();
}

/** Stop reconnects and destroy the socket. A blocking QUIT would wait forever on Redis 5. */
export async function destroyRedisClient(client: object | null | undefined): Promise<void> {
  const redis = client as RedisLike | null | undefined;
  if (!redis) return;
  sealRedisClient(redis);
  if (redis.status === 'end' || typeof redis.disconnect !== 'function') {
    destroySocket(redis);
    return;
  }
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, 1_000);
    if (typeof redis.once === 'function') redis.once('end', finish);
    try {
      redis.disconnect?.(false);
      destroySocket(redis);
    } catch {
      finish();
      return;
    }
    if (redis.status === 'end' || typeof redis.once !== 'function') finish();
  });
}

function openClientCount(clients: Array<{ status?: string }>) {
  return clients.filter((client) => client.status && client.status !== 'end' && client.status !== 'wait').length;
}

export function countRedisClients(resources: BullResource[], extra: Array<{ status?: string }> = []) {
  const clients = [...resources.flatMap((resource) => bullRedisClients(resource)), ...extra];
  return { clients: clients.length, open: openClientCount(clients) };
}

/**
 * Closes BullMQ resources without waiting on a blocking command.
 * Connection resets raised only while this is running are counted, not treated as runtime failures.
 */
export async function closeBullResources(resources: BullResource[], timeoutMs = 8_000): Promise<Error[]> {
  const errors: Error[] = [];
  enterRedisShutdown();
  const sinks: Array<{ resource: BullResource; handler: (error: Error) => void }> = [];
  try {
    for (const resource of resources) {
      for (const client of bullRedisClients(resource)) sealRedisClient(client);
      if ((resource.listenerCount?.('error') ?? 0) === 0 && resource.on) {
        const handler = (error: Error) => {
          if (isShutdownConnectionError(error)) {
            noteShutdownReset();
            return;
          }
          errors.push(error instanceof Error ? error : new Error('BullMQ resource error'));
        };
        resource.on('error', handler);
        sinks.push({ resource, handler });
      }
    }

    await Promise.all(resources.map(async (resource) => {
      let timer: NodeJS.Timeout | undefined;
      const closing = (async () => {
        const force = typeof resource.isRunning === 'function';
        await resource.close?.(force);
      })().catch((error: unknown) => {
        if (!isShutdownConnectionError(error)) {
          errors.push(error instanceof Error ? error : new Error('BullMQ resource close failed'));
        } else {
          noteShutdownReset();
        }
      });
      try {
        await Promise.race([
          closing,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('BullMQ resource close timed out')), timeoutMs);
          }),
        ]);
      } catch (error) {
        if (error instanceof Error && error.message === 'BullMQ resource close timed out') {
          errors.push(error);
        } else if (!isShutdownConnectionError(error)) {
          errors.push(error instanceof Error ? error : new Error('BullMQ resource close failed'));
        } else {
          noteShutdownReset();
        }
      } finally {
        if (timer) clearTimeout(timer);
        await Promise.all(bullRedisClients(resource).map((client) => destroyRedisClient(client)));
      }
    }));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    leaveRedisShutdown();
    for (const sink of sinks) {
      const emitter = sink.resource as BullResource & { off?: (event: 'error', listener: (error: Error) => void) => void };
      emitter.off?.('error', sink.handler);
    }
  }
  return errors;
}
