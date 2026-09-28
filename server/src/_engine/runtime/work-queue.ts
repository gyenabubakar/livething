import { ConnectionBusy } from '@livething/core';
import type { RuntimeConnection } from './types.ts';

/** Maximum number of admitted but unfinished ordered handlers per connection. */
export const MAX_PENDING_CONNECTION_WORK = 256;

const CONNECTION_BUSY_RETRY_AFTER_MS = 1_000;

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

  const queue = (connection.workQueue ??= { tail: Promise.resolve(), pending: 0 });
  if (queue.pending >= MAX_PENDING_CONNECTION_WORK) {
    return Promise.reject(ConnectionBusy({ retryAfterMs: CONNECTION_BUSY_RETRY_AFTER_MS }));
  }

  queue.pending += 1;
  const next = queue.tail.then(work, work);
  queue.tail = next.then(
    () => {
      queue.pending -= 1;
    },
    () => {
      queue.pending -= 1;
    },
  );

  return next;
}
