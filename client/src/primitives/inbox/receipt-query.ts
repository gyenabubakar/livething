import { Disconnected, Timeout } from '~/errors.ts';
import type { PrimitiveHelpers, WireMessage } from '~/internal/runtime.ts';
import type { ScopeInfo } from '~/internal/scoped.ts';

/** A `receivedBy`/`seenBy` call waiting on its `__receiptQuery__` answer. */
export interface PendingQuery {
  resolve: (identities: string[]) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Send a `__receiptQuery__` and resolve once the matching answer arrives. Each
 * primitive keeps its own `pending` map keyed on correlationId, so inbox's
 * `received` queries and read-receipts' `seen` queries never collide.
 */
export function runReceiptQuery(
  helpers: PrimitiveHelpers,
  pending: Map<string, PendingQuery>,
  args: { scope: ScopeInfo; seq: number; kind: 'seen' | 'received'; timeout: number },
): Promise<string[]> {
  const { scope, seq, kind, timeout } = args;
  return new Promise<string[]>((resolve, reject) => {
    scope.assertReady?.();
    const correlationId = helpers.generateId('receipt');
    const timer = setTimeout(() => {
      pending.delete(correlationId);
      reject(Timeout());
    }, timeout);
    pending.set(correlationId, { resolve, reject, timer });
    const result = helpers.rawSend({
      event: '__receiptQuery__',
      payload: { seq, kind },
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
 * Try to settle a `__receiptQuery__` answer against this primitive's pending
 * queries. Returns `null` (consumed) when the correlationId is ours, or the
 * message unchanged so the next primitive can claim it.
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
  const identities = (message.payload as { identities?: unknown })?.identities;
  waiter.resolve(Array.isArray(identities) ? identities.filter(isString) : []);
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
