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
  // Copy only when there's more than one handler, so a handler that unsubscribes
  // a sibling mid-dispatch can't disturb the loop. With 0-1 handlers (the common
  // case) the Set is safe to iterate directly — no copy.
  const snapshot = handlers instanceof Set && handlers.size <= 1 ? handlers : [...handlers];
  for (const handler of snapshot) {
    try {
      handler(...args);
    } catch (error) {
      log.error('a message handler threw', error);
    }
  }
}
