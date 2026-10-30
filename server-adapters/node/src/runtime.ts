import type { Logger, StorageProvider } from '@livething/server/adapters';
import { createLogger } from './logger.ts';
import { createPlatform } from './platform.ts';
import { createStorage, createTimers } from './providers/index.ts';
import type { NodeStorageOptions } from './providers/storage.ts';
import type { NodeTimers } from './providers/timers.ts';

/** Runtime dependencies assembled by the public Node server. */
export interface NodeRuntimeOptions extends Omit<NodeStorageOptions, 'logger'> {
  logger?: Logger;
}

/** The Node runtime services passed into the LiveThing engine. */
export interface NodeRuntime {
  platform: ReturnType<typeof createPlatform>;
  storage: StorageProvider;
  timers: NodeTimers;
  logger: Logger;
  close(): Promise<void>;
}

/** Creates storage, timers, and logging services. */
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
    logger,
    async close() {
      timers.stop();
      await timers.drain();
      storageRuntime.close();
    },
  };
}
