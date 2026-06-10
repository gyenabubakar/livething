import type { PrimitiveLogger } from '~/internal/runtime.ts';

/**
 * Call every handler with the given arguments. If one handler throws, the error
 * is logged and the remaining handlers still run. The error is reported through
 * `log` (only visible when debug mode is on). Used everywhere an event fans out
 * to user `on()` handlers: top level, channels, and namespaces.
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
      log.error('a message handler threw', error);
    }
  }
}
