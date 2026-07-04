import { channelKey } from '~/internal/channel-key.ts';
import { getAugmenters } from '~/internal/scoped.ts';
import { createStore } from '~/internal/store.ts';
import {
  rejectPending,
  resolveOwnQuery,
  runReceiptQuery,
} from '~/primitives/inbox/receipt-query.ts';
import type { PrimitiveHelpers, WireMessage, WSKitEnvelope } from '~/internal/runtime.ts';
import type { ScopeMarkers } from '~/internal/scoped.ts';
import type { WritableStore } from '~/internal/store.ts';
import type { PendingQuery } from '~/primitives/inbox/receipt-query.ts';
import type {
  ChannelInboxApi,
  ChannelReceipt,
  InboxTypeFn,
  ReceiptSnapshot,
} from '~/primitives/inbox/types.ts';
import type { Primitive } from '~/primitives/types.ts';

interface ScopeMark {
  seq: number;
  channel: string;
  channelFamily?: string;
  acked: number;
}

/** One channel's delivered-receipt state: cursors per identity plus a reactive store. */
interface ChannelReceipts {
  byIdentity: Map<string, ChannelReceipt>;
  store: WritableStore<ReceiptSnapshot>;
  listeners: Set<(receipt: ChannelReceipt) => void>;
}

/** Options for the client `inbox()` primitive. */
export interface InboxOptions {
  /** Default wait for a `receivedBy` answer before rejecting, in ms. Defaults to 10s; override per call. */
  timeout?: number;
}

const DEFAULT_QUERY_TIMEOUT_MS = 10_000;

/**
 * Confirms guaranteed per-member channel delivery and surfaces the delivered
 * acknowledgement (the double-grey check). As inbox messages arrive it tracks
 * the highest sequence per channel and acks the server with `__received__`, so
 * the server drops that member's held copy; on reconnect it re-sends each
 * channel's high-water mark. It reads the server's `__receipt__` broadcasts into
 * a per-channel reactive store and adds `receipts`, `onReceipt`, and `receivedBy`
 * to each inbox channel handle.
 *
 * It learns which channels are inbox-backed from the `__wskit.inbox` flag on
 * `__subscribeOk__`, and acks only those. It needs `dedup()`, because the server
 * re-delivers held copies on reconnect and dedup filters the ones already seen.
 */
export function inbox(options: InboxOptions = {}): Primitive<InboxTypeFn> {
  const defaultTimeout = options.timeout ?? DEFAULT_QUERY_TIMEOUT_MS;
  return {
    _tag: 'inbox',
    dependencies: ['dedup'],
    // After channels, so a rejoin reaches the server before this scope's ack.
    optionalAfter: ['channels'],
    setup(helpers) {
      const marks = new Map<string, ScopeMark>();
      const inboxScopes = new Set<string>();
      const channels = new Map<string, ChannelReceipts>();
      const pendingQueries = new Map<string, PendingQuery>();
      let flushScheduled = false;

      function stateFor(key: string): ChannelReceipts {
        let state = channels.get(key);
        if (!state) {
          state = {
            byIdentity: new Map(),
            store: createStore<ReceiptSnapshot>(new Map()),
            listeners: new Set(),
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
            helpers.log.error('onReceipt listener threw', error);
          }
        }
      }

      function scheduleFlush(): void {
        if (flushScheduled) return;
        flushScheduled = true;
        queueMicrotask(() => {
          flushScheduled = false;
          for (const [key, mark] of marks) {
            if (!inboxScopes.has(key)) continue;
            if (mark.seq <= mark.acked) continue;
            mark.acked = mark.seq;
            sendReceived(helpers, mark);
          }
        });
      }

      return {
        id: 'inbox',
        onIncoming(message) {
          const channel = message.__wskit?.channel;
          if (channel === undefined) return message;
          const key = channelKey(message.__wskit?.channelFamily, channel);

          if (message.event === '__subscribeOk__') {
            if (message.__wskit?.inbox === true) inboxScopes.add(key);
            return message;
          }
          if (message.event === '__unsubscribeOk__' || message.event === '__kicked__') {
            inboxScopes.delete(key);
            marks.delete(key);
            const state = channels.get(key);
            if (state) {
              state.byIdentity.clear();
              state.store.set(new Map());
            }
            return message;
          }

          if (message.event === '__receiptQuery__') {
            return resolveOwnQuery(pendingQueries, message);
          }

          if (message.event === '__receipt__') {
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
              seenThrough:
                typeof payload.seenThrough === 'number' ? payload.seenThrough : undefined,
            });
            return null;
          }

          // Stream chunks carry a per-stream seq unrelated to inbox ordering.
          if (message.__wskit?.streamId !== undefined) return message;
          const seq = message.__wskit?.seq;
          if (typeof seq !== 'number') return message;

          const channelFamily = message.__wskit?.channelFamily;
          const current = marks.get(key);
          if (!current) {
            marks.set(key, { seq, channel, channelFamily, acked: 0 });
          } else if (seq > current.seq) {
            current.seq = seq;
          }
          scheduleFlush();
          return message;
        },
        onReconnect() {
          const requests: WireMessage[] = [];
          for (const [key, mark] of marks) {
            if (inboxScopes.has(key)) requests.push(buildReceived(mark));
          }
          return requests.length > 0 ? requests : null;
        },
        onClose() {
          rejectPending(pendingQueries);
        },
        install(socket) {
          getAugmenters(socket).push((messaging, scope) => {
            const key = markersKey(scope.markers());
            const state = stateFor(key);

            const inboxApi: ChannelInboxApi = {
              receipts: { get: state.store.store.get, subscribe: state.store.store.subscribe },
              onReceipt: (callback) => {
                state.listeners.add(callback);
                return () => state.listeners.delete(callback);
              },
              receivedBy: (seq, queryOptions) =>
                runReceiptQuery(helpers, pendingQueries, {
                  scope,
                  seq,
                  kind: 'received',
                  timeout: queryOptions?.timeout ?? defaultTimeout,
                }),
            };
            Object.assign(messaging, inboxApi);
          });
        },
      };
    },
  };
}

function buildReceived(mark: ScopeMark): WireMessage {
  const wskit: WSKitEnvelope = { channel: mark.channel };
  if (mark.channelFamily) wskit.channelFamily = mark.channelFamily;
  return {
    event: '__received__',
    payload: { receivedThrough: mark.seq },
    __wskit: wskit,
  };
}

function sendReceived(helpers: PrimitiveHelpers, mark: ScopeMark): void {
  helpers.rawSend(buildReceived(mark));
}

function markersKey(markers: ScopeMarkers): string {
  return channelKey(markers.channelFamily, markers.channel ?? '');
}

inbox.tag = 'inbox';
