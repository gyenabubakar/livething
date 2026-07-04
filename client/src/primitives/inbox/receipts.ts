import { Disconnected, Timeout } from '~/errors.ts';
import { channelKey } from '~/internal/channel-key.ts';
import { getAugmenters } from '~/internal/scoped.ts';
import { createStore } from '~/internal/store.ts';
import type { ScopeInfo, ScopeMarkers } from '~/internal/scoped.ts';
import type { ReadableStore, WritableStore } from '~/internal/store.ts';
import type {
  ChannelReceipt,
  ReceiptQueryOptions,
  ReceiptSnapshot,
  ReceiptsTypeFn,
} from '~/primitives/inbox/types.ts';
import type { Primitive } from '~/primitives/types.ts';

/** One channel's live receipt state: cursors per identity plus a reactive store. */
interface ChannelReceipts {
  byIdentity: Map<string, ChannelReceipt>;
  store: WritableStore<ReceiptSnapshot>;
  listeners: Set<(receipt: ChannelReceipt) => void>;
  /** Highest sequence THIS client has received on the channel — the `markSeen()` default. */
  ownReceived: number;
}

/** Options for the client `receipts()` primitive. */
export interface ReceiptsOptions {
  /** Default wait for a `seenBy`/`receivedBy` answer before rejecting, in ms. Defaults to 10s; override per call. */
  timeout?: number;
}

const DEFAULT_QUERY_TIMEOUT_MS = 10_000;

/**
 * Tracks delivered + seen acknowledgements on inbox channels. It reads the
 * server's `__receipt__` broadcasts into a per-channel reactive store and adds
 * `markSeen`, `onReceipt`, and `receipts` to each channel handle. Enable
 * `receipts` on the server channel to drive it.
 */
export function receipts(options: ReceiptsOptions = {}): Primitive<ReceiptsTypeFn> {
  const defaultTimeout = options.timeout ?? DEFAULT_QUERY_TIMEOUT_MS;
  return {
    _tag: 'receipts',
    optionalAfter: ['channels', 'inbox'],
    setup(helpers) {
      const channels = new Map<string, ChannelReceipts>();
      const pendingQueries = new Map<string, PendingQuery>();

      function stateFor(key: string): ChannelReceipts {
        let state = channels.get(key);
        if (!state) {
          state = {
            byIdentity: new Map(),
            store: createStore<ReceiptSnapshot>(new Map()),
            listeners: new Set(),
            ownReceived: 0,
          };
          channels.set(key, state);
        }
        return state;
      }

      function applyReceipt(
        key: string,
        receipt: { identity: string; receivedThrough?: number; seenThrough?: number },
      ): void {
        const state = stateFor(key);
        const previous = state.byIdentity.get(receipt.identity);
        const next: ChannelReceipt = {
          identity: receipt.identity,
          receivedThrough: Math.max(previous?.receivedThrough ?? 0, receipt.receivedThrough ?? 0),
          seenThrough: Math.max(previous?.seenThrough ?? 0, receipt.seenThrough ?? 0),
        };
        state.byIdentity.set(receipt.identity, next);
        state.store.set(new Map(state.byIdentity));
        for (const listener of [...state.listeners]) {
          try {
            listener(next);
          } catch (error) {
            helpers.log.error('receipts onReceipt listener threw', error);
          }
        }
      }

      return {
        id: 'receipts',
        onIncoming(message) {
          const channel = message.__wskit?.channel;
          if (channel === undefined) return message;
          const key = channelKey(message.__wskit?.channelFamily, channel);

          if (message.event === '__unsubscribeOk__' || message.event === '__kicked__') {
            // A later rejoin to the same channel key starts fresh — a bare
            // markSeen() must not target the pre-leave high-water mark.
            const state = channels.get(key);
            if (state) {
              state.ownReceived = 0;
              state.byIdentity.clear();
              state.store.set(new Map());
            }
            return message;
          }

          if (message.event === '__receiptQuery__') {
            const correlationId = message.__wskit?.correlationId;
            const waiter = correlationId ? pendingQueries.get(correlationId) : undefined;
            if (!waiter || correlationId === undefined) return null;
            pendingQueries.delete(correlationId);
            clearTimeout(waiter.timer);
            const identities = (message.payload as { identities?: unknown })?.identities;
            waiter.resolve(Array.isArray(identities) ? identities.filter(isString) : []);
            return null;
          }

          if (message.event !== '__receipt__') {
            const seq = message.__wskit?.seq;
            if (typeof seq === 'number' && message.__wskit?.streamId === undefined) {
              const state = stateFor(key);
              if (seq > state.ownReceived) state.ownReceived = seq;
            }
            return message;
          }

          const payload = message.payload as {
            identity?: unknown;
            receivedThrough?: unknown;
            seenThrough?: unknown;
          };
          if (typeof payload?.identity !== 'string') return null;

          applyReceipt(key, {
            identity: payload.identity,
            receivedThrough:
              typeof payload.receivedThrough === 'number' ? payload.receivedThrough : undefined,
            seenThrough: typeof payload.seenThrough === 'number' ? payload.seenThrough : undefined,
          });
          return null;
        },

        onClose() {
          const waiters = [...pendingQueries.values()];
          pendingQueries.clear();
          for (const waiter of waiters) {
            clearTimeout(waiter.timer);
            waiter.reject(Disconnected());
          }
        },

        install(socket) {
          function query(args: {
            scope: ScopeInfo;
            seq: number;
            kind: 'seen' | 'received';
            timeout: number;
          }): Promise<string[]> {
            const { scope, seq, kind, timeout } = args;
            return new Promise<string[]>((resolve, reject) => {
              // A query needs a live answer, so fail fast rather than buffer and hang.
              scope.assertReady?.();
              const correlationId = helpers.generateId('receipt');
              const timer = setTimeout(() => {
                pendingQueries.delete(correlationId);
                reject(Timeout());
              }, timeout);
              pendingQueries.set(correlationId, { resolve, reject, timer });
              const result = helpers.rawSend({
                event: '__receiptQuery__',
                payload: { seq, kind },
                __wskit: { ...scope.markers(), correlationId },
              });
              if (result !== 'sent') {
                clearTimeout(timer);
                pendingQueries.delete(correlationId);
                reject(Disconnected());
              }
            });
          }

          getAugmenters(socket).push((messaging, scope) => {
            const key = markersKey(scope.markers());
            const state = stateFor(key);

            messaging.markSeen = (seq?: number): void => {
              scope.assertReady?.();
              const seenThrough = seq ?? state.ownReceived;
              helpers.rawSend({
                event: '__seen__',
                payload: { seenThrough },
                __wskit: scope.markers(),
              });
            };

            messaging.onReceipt = (callback: (receipt: ChannelReceipt) => void): (() => void) => {
              state.listeners.add(callback);
              return () => state.listeners.delete(callback);
            };

            messaging.receipts = {
              get: state.store.store.get,
              subscribe: state.store.store.subscribe,
              receivedBy: (seq, options) =>
                query({
                  scope,
                  seq,
                  kind: 'received',
                  timeout: options?.timeout ?? defaultTimeout,
                }),
              seenBy: (seq, options) =>
                query({ scope, seq, kind: 'seen', timeout: options?.timeout ?? defaultTimeout }),
            } satisfies ChannelReceiptsHandle;
          });
        },
      };
    },
  };
}

/** A `seenBy`/`receivedBy` call waiting on its `__receiptQuery__` answer. */
interface PendingQuery {
  resolve: (identities: string[]) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** The runtime shape the augmenter attaches under `room.receipts`. */
interface ChannelReceiptsHandle extends ReadableStore<ReceiptSnapshot> {
  receivedBy(seq: number, options?: ReceiptQueryOptions): Promise<string[]>;
  seenBy(seq: number, options?: ReceiptQueryOptions): Promise<string[]>;
}

function markersKey(markers: ScopeMarkers): string {
  return channelKey(markers.channelFamily, markers.channel ?? '');
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

receipts.tag = 'receipts';
