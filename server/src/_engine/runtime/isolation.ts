/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { Logger } from '~/context.ts';

interface IsolationOptions {
  /** Human-readable label for logs, e.g. `"tag fan-out 'role/admin'"`. */
  context: string;
  /**
   * Engine logger. Optional because some call sites don't have one handy
   * (tags runtime, helpers built before logger threading). Falls back to
   * `console.error` so the failure is never silently swallowed.
   */
  logger?: Logger;
}

function reportIsolated(error: unknown, options: IsolationOptions): void {
  const message = `[wskit] ${options.context} threw: ${error instanceof Error ? error.message : String(error)}`;
  if (options.logger) {
    options.logger.error(message, { error });
    return;
  }
  // eslint-disable-next-line no-console
  console.error(message, error);
}

/**
 * Run a fanout/hook over `items` so one bad item never aborts the rest.
 * Each invocation is wrapped in try/catch — a throw is logged and the loop
 * continues to the next item. Use this anywhere the intent is "deliver to
 * every X" or "notify every hook," and one failing X should not silence the
 * rest. Sync only — match the synchronous send pipelines this is built for.
 */
export function forEachIsolated<T>(
  items: Iterable<T>,
  fn: (item: T) => void,
  options: IsolationOptions,
): void {
  for (const item of items) {
    try {
      fn(item);
    } catch (error) {
      reportIsolated(error, options);
    }
  }
}

/**
 * Run an async fanout/hook the same way as `forEachIsolated` but awaits each
 * call serially. Use when the loop body is async and order matters; if order
 * doesn't matter and you want concurrency, the caller should switch to
 * `Promise.allSettled` instead.
 */
export async function forEachIsolatedAsync<T>(
  items: Iterable<T>,
  fn: (item: T) => Promise<void> | void,
  options: IsolationOptions,
): Promise<void> {
  for (const item of items) {
    try {
      await fn(item);
    } catch (error) {
      reportIsolated(error, options);
    }
  }
}
