import type { RuntimeConnection } from './types.ts';

/**
 * Run one connection's ordered work after the work already admitted for that
 * connection. Interleaved work skips the queue but still runs on the same
 * connection.
 */
export function runConnectionWork<T>(
  connection: Pick<RuntimeConnection, 'workQueue'>,
  allowInterleaving: boolean,
  work: () => T | PromiseLike<T>,
): Promise<T> {
  if (allowInterleaving) return Promise.resolve(work());

  const queue = (connection.workQueue ??= { tail: Promise.resolve() });
  const next = queue.tail.then(work, work);
  queue.tail = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}
