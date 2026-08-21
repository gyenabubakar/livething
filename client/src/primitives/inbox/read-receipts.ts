import { channelKey } from '~/internal/channel-key.ts';
import { getAugmenters } from '~/internal/scoped.ts';
import { createStore } from '~/internal/store.ts';
import { isRejoinConfirmation } from '~/primitives/channels/leave-confirmation.ts';
import {
  rejectPending,
  resolveOwnQuery,
  runReceiptQuery,
} from '~/primitives/inbox/receipt-query.ts';
import type { ScopeMarkers } from '~/internal/scoped.ts';
import type { ReadableStore, WritableStore } from '~/internal/store.ts';
import type { ChannelStatus } from '~/primitives/channels/types.ts';
import type { PendingQuery } from '~/primitives/inbox/receipt-query.ts';
import type {
  ChannelReadReceiptsApi,
  CursorList,
  ReadReceiptsPrimitive,
} from '~/primitives/inbox/types.ts';

/** One channel's read-receipt state: the read cursor per user id plus its store. */
interface ChannelReaders {
  byUserId: Map<string, number>;
  store: WritableStore<CursorList>;
  listeners: Set<(userId: string, readThrough: number) => void>;
  /** The channel status used to clear state if a queued rejoin fails. */
  status: ReadableStore<ChannelStatus> | null;
  stopStatusWatch: (() => void) | null;
}

/** Options for the client `readReceipts()` primitive. */
export interface ReadReceiptsOptions {
  /** Default wait for a `readersOf` answer before rejecting, in ms. Defaults to 10s; override per call. */
  timeout?: number;
}

const DEFAULT_QUERY_TIMEOUT_MS = 10_000;

/**
 * Adds read acknowledgement (the blue check) to inbox channels that opted in.
 * `markAsRead(seq)` advances the server's read cursor (omit `seq` to mark
 * everything received so far); `readersOf(seq)` asks who has read up to a
 * sequence; `readers`/`onRead` surface the server's `__read__` fan-out. The
 * received surface (`receivers`/`onReceived`/`receiversOf`) belongs to `inbox()`.
 */
export function readReceipts(options: ReadReceiptsOptions = {}): ReadReceiptsPrimitive {
  const defaultTimeout = options.timeout ?? DEFAULT_QUERY_TIMEOUT_MS;
  return {
    _tag: 'read-receipts',
    optionalAfter: ['channels', 'inbox'],
    setup(helpers) {
      // Highest non-stream seq received per channel — the `markAsRead()` default.
      const ownReceived = new Map<string, number>();
      const channels = new Map<string, ChannelReaders>();
      const pendingQueries = new Map<string, PendingQuery>();

      function stateFor(key: string): ChannelReaders {
        let state = channels.get(key);
        if (!state) {
          state = {
            byUserId: new Map(),
            store: createStore<CursorList>(new Map()),
            listeners: new Set(),
            status: null,
            stopStatusWatch: null,
          };
          channels.set(key, state);
        }
        return state;
      }

      function applyRead(key: string, userId: string, readThrough: number): void {
        const state = stateFor(key);
        const previous = state.byUserId.get(userId) ?? 0;
        if (readThrough <= previous) return;
        state.byUserId.set(userId, readThrough);
        state.store.set(projectCursor(state.byUserId));
        for (const listener of [...state.listeners]) {
          try {
            listener(userId, readThrough);
          } catch (error) {
            helpers.log.report(error);
          }
        }
      }

      function clearScope(key: string, state = channels.get(key)): void {
        ownReceived.delete(key);
        if (state) {
          state.byUserId.clear();
          state.store.set(new Map());
        }
      }

      return {
        id: 'read-receipts',
        onIncoming(message) {
          const channel = message.__wskit?.channel;
          if (channel === undefined) return message;
          const key = channelKey(message.__wskit?.channelFamily, channel);

          if (message.event === '__unsubscribeOk__' || message.event === '__kicked__') {
            if (message.event === '__unsubscribeOk__' && isRejoinConfirmation(message))
              return message;
            clearScope(key);
            return message;
          }

          if (message.event === '__readQuery__') {
            return resolveOwnQuery(pendingQueries, message);
          }

          if (message.event === '__read__') {
            const payload = message.payload as { userId?: unknown; readThrough?: unknown };
            if (typeof payload?.userId === 'string' && typeof payload.readThrough === 'number') {
              applyRead(key, payload.userId, payload.readThrough);
            }
            return null;
          }

          if (message.event !== '__received__') {
            const seq = message.__wskit?.seq;
            if (typeof seq === 'number' && message.__wskit?.streamId === undefined) {
              if (seq > (ownReceived.get(key) ?? 0)) ownReceived.set(key, seq);
            }
          }
          return message;
        },

        onClose() {
          rejectPending(pendingQueries);
        },

        install(socket) {
          getAugmenters(socket).push((messaging, scope) => {
            const key = markersKey(scope.markers());
            const state = stateFor(key);
            // channels() builds every channel messaging with a `status` store; it
            // runs before this augmenter registers (readReceipts sorts after
            // channels), so it is always present by the time a handle is built.
            const status = (messaging as { status?: ReadableStore<ChannelStatus> }).status ?? null;
            if (state.status !== status) {
              state.stopStatusWatch?.();
              state.status = status;
              state.stopStatusWatch =
                status?.subscribe((next) => {
                  if (next === 'failed') clearScope(key, state);
                }) ?? null;
              if (status?.get() === 'failed') clearScope(key, state);
            }
            const readApi: ChannelReadReceiptsApi = {
              readers: { get: state.store.store.get, subscribe: state.store.store.subscribe },
              onRead: (callback) => {
                state.listeners.add(callback);
                return () => state.listeners.delete(callback);
              },
              readersOf: (seq, queryOptions) =>
                runReceiptQuery(helpers, pendingQueries, {
                  scope,
                  seq,
                  event: '__readQuery__',
                  timeout: queryOptions?.timeout ?? defaultTimeout,
                }),
              markAsRead: (seq) => {
                scope.assertReady?.();
                helpers.rawSend({
                  event: '__read__',
                  payload: { readThrough: seq ?? ownReceived.get(key) ?? 0 },
                  __wskit: scope.markers(),
                });
              },
            };
            Object.assign(messaging, readApi);
          });
        },
      };
    },
  };
}

/** Drop members still at `0` from the read cursor map. */
function projectCursor(byUserId: ReadonlyMap<string, number>): CursorList {
  const list = new Map<string, number>();
  for (const [userId, cursor] of byUserId) {
    if (cursor > 0) list.set(userId, cursor);
  }
  return list;
}

function markersKey(markers: ScopeMarkers): string {
  return channelKey(markers.channelFamily, markers.channel ?? '');
}

readReceipts.tag = 'read-receipts';
