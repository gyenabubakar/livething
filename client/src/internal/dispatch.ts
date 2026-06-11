import type { PrimitiveLogger } from '~/internal/runtime.ts';

/**
 * Call every handler with the given arguments. If one handler throws, it is
 * surfaced on the socket's `error` event (via `log.report`) and the remaining
 * handlers still run. Used everywhere an event fans out to user `on()` handlers:
 * top level and channels.
 */
export function dispatchToHandlers<A extends unknown[]>(
  handlers: Iterable<(...args: A) => void> | undefined,
  log: PrimitiveLogger,
  ...args: A
): void {
  if (!handlers) return;
  const snapshot = [...handlers];
  for (const handler of snapshot) {
    try {
      handler(...args);
    } catch (error) {
      log.report(error);
    }
  }
}
