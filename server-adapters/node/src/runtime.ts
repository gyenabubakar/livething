import type { Logger, StorageProvider } from '@wskit/server/adapters';
import type { Server } from 'node:http';
import { createAsyncContext } from './async-context.ts';
import { createLogger } from './logger.ts';
import { createPlatform } from './platform.ts';
import { createStorage, createTimers } from './providers/index.ts';
import type { NodeStorageOptions } from './providers/storage.ts';
import type { NodeTimers } from './providers/timers.ts';

/** Runtime dependencies assembled by the public Node server. */
export interface NodeRuntimeOptions<Env> extends Omit<NodeStorageOptions, 'logger'> {
  server: Server;
  env: Env;
  logger?: Logger;
}

/** The Node runtime services passed into the WSKit engine. */
export interface NodeRuntime<Env> {
  env: Record<string, unknown>;
  platform: ReturnType<typeof createPlatform<Env>>;
  storage: StorageProvider;
  timers: NodeTimers;
  asyncContextFactory: typeof createAsyncContext;
  logger: Logger;
  close(): Promise<void>;
}

/** Creates storage, timers, async context, and logging services. */
export function createRuntime<Env>(options: NodeRuntimeOptions<Env>): NodeRuntime<Env> {
  const logger = options.logger ?? createLogger();
  const storageRuntime = createStorage({
    sql: options.sql,
    kv: options.kv,
    logger,
  });
  const timers = createTimers(storageRuntime.storage.sql, logger);

  return {
    env: (options.env ?? {}) as Record<string, unknown>,
    platform: createPlatform(options.server, options.env),
    storage: storageRuntime.storage,
    timers,
    asyncContextFactory: createAsyncContext,
    logger,
    async close() {
      timers.stop();
      await timers.drain();
      storageRuntime.close();
    },
  };
}
