import type { Logger } from '@wskit/server/adapters';

export interface NodeWaitUntil {
  waitUntil(promise: Promise<unknown>): void;
  drain(): Promise<void>;
}

export function createWaitUntil(logger: Logger): NodeWaitUntil {
  const pending = new Set<Promise<void>>();

  function waitUntil(promise: Promise<unknown>): void {
    let tracked: Promise<void>;
    tracked = Promise.resolve(promise)
      .then(() => undefined)
      .catch((error: unknown) => {
        logger.error('[wskit] waitUntil task failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        pending.delete(tracked);
      });
    pending.add(tracked);
  }

  async function drain(): Promise<void> {
    while (pending.size > 0) {
      await Promise.all([...pending]);
    }
  }

  return { waitUntil, drain };
}
