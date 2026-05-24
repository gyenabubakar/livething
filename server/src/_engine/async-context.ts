import type { AsyncContext } from '~/context.ts';

/**
 * Run `fn` with `connectionId` recorded as the active connection so engine
 * helpers called inside it — notably a plugin's `getState()` — resolve to the
 * right connection even while other connections' handlers interleave.
 *
 * When the adapter provided no async-context capability, `fn` still runs; only
 * `getState()` depends on the capability, and it throws on its own if missing.
 */
export function withConnectionContext<T>(
  asyncContext: AsyncContext | undefined,
  connectionId: string,
  fn: () => T,
): T {
  return asyncContext ? asyncContext.run(connectionId, fn) : fn();
}
