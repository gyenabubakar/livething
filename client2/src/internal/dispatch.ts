import type { PrimitiveLogger } from '~/internal/runtime.ts';

/**
 * Call every handler with the given arguments, isolating throws so one bad
 * handler can't stop its siblings (the other handlers for the same event). A
 * throw is reported through `log` — the debug-gated log channel — so it is never
 * silently dropped, yet stays quiet unless `debug` logging is on. Used by every
 * place that fans an event out to user `on()` handlers: top level, channels, and
 * namespaces.
 */
export function dispatchToHandlers<A extends unknown[]>(
  handlers: Iterable<(...args: A) => void> | undefined,
  log: PrimitiveLogger,
  ...args: A
): void {
  if (!handlers) return;
  for (const handler of [...handlers]) {
    try {
      handler(...args);
    } catch (error) {
      log.error('a message handler threw', error);
    }
  }
}
