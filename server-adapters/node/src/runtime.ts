import type { Logger, StorageProvider } from '@wskit/server/adapters';
import type { Server } from 'node:http';
import { createAsyncContext } from './async-context.ts';
import { createLogger } from './logger.ts';
import { createPlatform } from './platform.ts';
import { createStorage, createTimers } from './providers/index.ts';
import { createWaitUntil } from './wait-until.ts';
import type { NodeStorageOptions } from './providers/storage.ts';
import type { NodeTimers } from './providers/timers.ts';
import type { NodeWaitUntil } from './wait-until.ts';

export interface NodeRuntimeOptions<Env> extends Omit<NodeStorageOptions, 'logger'> {
  server: Server;
  env: Env;
  logger?: Logger;
}

export interface NodeRuntime<Env> {
  env: Record<string, unknown>;
  platform: ReturnType<typeof createPlatform<Env>>;
  storage: StorageProvider;
  timers: NodeTimers;
  asyncContextFactory: typeof createAsyncContext;
  waitUntil: NodeWaitUntil;
  logger: Logger;
  close(): Promise<void>;
}

export function createRuntime<Env>(options: NodeRuntimeOptions<Env>): NodeRuntime<Env> {
  const logger = options.logger ?? createLogger();
  const storageRuntime = createStorage({
    sql: options.sql,
    kv: options.kv,
    logger,
  });
  const timers = createTimers(storageRuntime.storage.sql, logger);
  const waitUntil = createWaitUntil(logger);

  return {
    env: (options.env ?? {}) as Record<string, unknown>,
    platform: createPlatform(options.server, options.env),
    storage: storageRuntime.storage,
    timers,
    asyncContextFactory: createAsyncContext,
    waitUntil,
    logger,
    async close() {
      timers.stop();
      await waitUntil.drain();
      storageRuntime.close();
    },
  };
}
