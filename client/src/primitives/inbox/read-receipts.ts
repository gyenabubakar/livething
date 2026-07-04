import { channelKey } from '~/internal/channel-key.ts';
import { getAugmenters } from '~/internal/scoped.ts';
import { createStore } from '~/internal/store.ts';
import {
  rejectPending,
  resolveOwnQuery,
  runReceiptQuery,
} from '~/primitives/inbox/receipt-query.ts';
import type { ScopeMarkers } from '~/internal/scoped.ts';
import type { WritableStore } from '~/internal/store.ts';
import type { PendingQuery } from '~/primitives/inbox/receipt-query.ts';
import type {
  ChannelReadReceiptsApi,
  CursorList,
  ReadReceiptsTypeFn,
} from '~/primitives/inbox/types.ts';
import type { Primitive } from '~/primitives/types.ts';

/** One channel's read-receipt state: the read cursor per identity plus its store. */
interface ChannelReaders {
  byIdentity: Map<string, number>;
  store: WritableStore<CursorList>;
  listeners: Set<(identity: string, readThrough: number) => void>;
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
export function readReceipts(options: ReadReceiptsOptions = {}): Primitive<ReadReceiptsTypeFn> {
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
            byIdentity: new Map(),
            store: createStore<CursorList>(new Map()),
            listeners: new Set(),
          };
          channels.set(key, state);
        }
        return state;
      }

      function applyRead(key: string, identity: string, readThrough: number): void {
        const state = stateFor(key);
        const next = Math.max(state.byIdentity.get(identity) ?? 0, readThrough);
        state.byIdentity.set(identity, next);
        state.store.set(projectCursor(state.byIdentity));
        for (const listener of [...state.listeners]) {
          try {
            listener(identity, next);
          } catch (error) {
            helpers.log.error('onRead listener threw', error);
          }
        }
      }

      return {
        id: 'read-receipts',
        onIncoming(message) {
          const channel = message.__wskit?.channel;
          if (channel === undefined) return message;
          const key = channelKey(message.__wskit?.channelFamily, channel);

          if (message.event === '__unsubscribeOk__' || message.event === '__kicked__') {
            ownReceived.delete(key);
            const state = channels.get(key);
            if (state) {
              state.byIdentity.clear();
              state.store.set(new Map());
            }
            return message;
          }

          if (message.event === '__readQuery__') {
            return resolveOwnQuery(pendingQueries, message);
          }

          if (message.event === '__read__') {
            const payload = message.payload as { identity?: unknown; readThrough?: unknown };
            if (typeof payload?.identity === 'string' && typeof payload.readThrough === 'number') {
              applyRead(key, payload.identity, payload.readThrough);
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
function projectCursor(byIdentity: ReadonlyMap<string, number>): CursorList {
  const list = new Map<string, number>();
  for (const [identity, cursor] of byIdentity) {
    if (cursor > 0) list.set(identity, cursor);
  }
  return list;
}

function markersKey(markers: ScopeMarkers): string {
  return channelKey(markers.channelFamily, markers.channel ?? '');
}

readReceipts.tag = 'read-receipts';
