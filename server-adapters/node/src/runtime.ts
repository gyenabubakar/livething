import type { Logger, StorageProvider } from '@wskit/server/adapters';
import { createAsyncContext } from './async-context.ts';
import { createLogger } from './logger.ts';
import { createPlatform } from './platform.ts';
import { createStorage, createTimers } from './providers/index.ts';
import type { NodeStorageOptions } from './providers/storage.ts';
import type { NodeTimers } from './providers/timers.ts';

/** Runtime dependencies assembled by the public Node server. */
export interface NodeRuntimeOptions extends Omit<NodeStorageOptions, 'logger'> {
  logger?: Logger;
}

/** The Node runtime services passed into the WSKit engine. */
export interface NodeRuntime {
  platform: ReturnType<typeof createPlatform>;
  storage: StorageProvider;
  timers: NodeTimers;
  asyncContextFactory: typeof createAsyncContext;
  logger: Logger;
  close(): Promise<void>;
}

/** Creates storage, timers, async context, and logging services. */
export function createRuntime(options: NodeRuntimeOptions): NodeRuntime {
  const logger = options.logger ?? createLogger();
  const storageRuntime = createStorage({
    sql: options.sql,
    kv: options.kv,
    logger,
  });
  const timers = createTimers(storageRuntime.storage.sql, logger);

  return {
    platform: createPlatform(),
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
