import { Disconnected, Timeout } from '~/errors.ts';
import { idGenerator } from '~/internal/id.ts';
import type { PrimitiveHelpers, WireMessage } from '~/internal/runtime.ts';
import type { ScopeInfo } from '~/internal/scoped.ts';

/** The two query events: inbox owns `__receivedQuery__`, read-receipts `__readQuery__`. */
export type ReceiptQueryEvent = '__receivedQuery__' | '__readQuery__';

/** A `receiversOf`/`readersOf` call waiting on its query answer. */
export interface PendingQuery {
  resolve: (identities: string[]) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Send a receipt query and resolve once the matching answer arrives. Each
 * primitive keeps its own `pending` map keyed on correlationId and its own event
 * name (`__receivedQuery__` for inbox, `__readQuery__` for read-receipts), so the
 * two never collide.
 */
export function runReceiptQuery(
  helpers: PrimitiveHelpers,
  pending: Map<string, PendingQuery>,
  args: { scope: ScopeInfo; seq: number; event: ReceiptQueryEvent; timeout: number },
): Promise<string[]> {
  const { scope, seq, event, timeout } = args;
  return new Promise<string[]>((resolve, reject) => {
    scope.assertReady?.();
    const correlationId = idGenerator(helpers)('receipt');
    const timer = setTimeout(() => {
      pending.delete(correlationId);
      reject(Timeout());
    }, timeout);
    pending.set(correlationId, { resolve, reject, timer });
    const result = helpers.rawSend({
      event,
      payload: { seq },
      __wskit: { ...scope.markers(), correlationId },
    });
    if (result !== 'sent') {
      clearTimeout(timer);
      pending.delete(correlationId);
      reject(Disconnected());
    }
  });
}

/**
 * Try to settle a query answer against this primitive's pending queries. Returns
 * `null` (consumed) when the correlationId is ours, or the message unchanged so
 * the next primitive can claim it.
 */
export function resolveOwnQuery(
  pending: Map<string, PendingQuery>,
  message: WireMessage,
): WireMessage | null {
  const correlationId = message.__wskit?.correlationId;
  const waiter = correlationId ? pending.get(correlationId) : undefined;
  if (!waiter || correlationId === undefined) return message;
  pending.delete(correlationId);
  clearTimeout(waiter.timer);
  const userIds = (message.payload as { userIds?: unknown })?.userIds;
  waiter.resolve(Array.isArray(userIds) ? userIds.filter(isString) : []);
  return null;
}

/** Reject every pending query with `Disconnected` when the socket closes. */
export function rejectPending(pending: Map<string, PendingQuery>): void {
  const waiters = [...pending.values()];
  pending.clear();
  for (const waiter of waiters) {
    clearTimeout(waiter.timer);
    waiter.reject(Disconnected());
  }
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}
