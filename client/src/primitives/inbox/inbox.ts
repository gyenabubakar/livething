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
import type { ReadableStore, WritableStore } from '~/internal/store.ts';
import type { ChannelStatus } from '~/primitives/channels/types.ts';
import type { PendingQuery } from '~/primitives/inbox/receipt-query.ts';
import type { ChannelInboxApi, CursorList, InboxPrimitive } from '~/primitives/inbox/types.ts';

interface ScopeMark {
  seq: number;
  channel: string;
  channelFamily?: string;
  acked: number;
}

/** One channel's received-receipt state: the received cursor per user id plus its store. */
interface ChannelReceivers {
  byUserId: Map<string, number>;
  store: WritableStore<CursorList>;
  listeners: Set<(userId: string, receivedThrough: number) => void>;
  status: ReadableStore<ChannelStatus> | null;
}

/** Options for the client `inbox()` primitive. */
export interface InboxOptions {
  /** Default wait for a `receiversOf` answer before rejecting, in ms. Defaults to 10s; override per call. */
  timeout?: number;
}

const DEFAULT_QUERY_TIMEOUT_MS = 10_000;

/**
 * Confirms guaranteed per-member channel delivery and surfaces the received
 * acknowledgement (the double-grey check). As inbox messages arrive it tracks
 * the highest sequence per channel and acks the server with `__received__`, so
 * the server drops that member's held copy; on reconnect it re-sends each
 * channel's high-water mark. It reads the server's `__received__` fan-out into a
 * per-channel `receivers` store and adds `receivers`, `onReceived`, and
 * `receiversOf` to each inbox channel handle.
 *
 * It learns which channels are inbox-backed from the `__wskit.inbox` flag on
 * `__subscribeOk__`, and acks only those. It needs `dedup()`, because the server
 * re-delivers held copies on reconnect and dedup filters the ones already seen.
 */
export function inbox(options: InboxOptions = {}): InboxPrimitive {
  const defaultTimeout = options.timeout ?? DEFAULT_QUERY_TIMEOUT_MS;
  return {
    _tag: 'inbox',
    dependencies: ['dedup'],
    // After channels, so a rejoin reaches the server before this scope's ack.
    optionalAfter: ['channels'],
    setup(helpers) {
      const marks = new Map<string, ScopeMark>();
      const inboxScopes = new Set<string>();
      const channels = new Map<string, ChannelReceivers>();
      const pendingQueries = new Map<string, PendingQuery>();
      let flushScheduled = false;

      function stateFor(key: string): ChannelReceivers {
        let state = channels.get(key);
        if (!state) {
          state = {
            byUserId: new Map(),
            store: createStore<CursorList>(new Map()),
            listeners: new Set(),
            status: null,
          };
          channels.set(key, state);
        }
        return state;
      }

      function applyReceived(key: string, userId: string, receivedThrough: number): void {
        const state = stateFor(key);
        const previous = state.byUserId.get(userId) ?? 0;
        if (receivedThrough <= previous) return;
        state.byUserId.set(userId, receivedThrough);
        state.store.set(projectCursor(state.byUserId));
        for (const listener of [...state.listeners]) {
          try {
            listener(userId, receivedThrough);
          } catch (error) {
            helpers.log.report(error);
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

      function isStaleUnsubscribeOk(state: ChannelReceivers | undefined): boolean {
        if (!state?.status) return false;
        const status = state.status.get();
        return status === 'subscribed' || status === 'subscribing';
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
            const state = channels.get(key);
            if (message.event === '__unsubscribeOk__' && isStaleUnsubscribeOk(state))
              return message;
            inboxScopes.delete(key);
            marks.delete(key);
            if (state) {
              state.byUserId.clear();
              state.store.set(new Map());
            }
            return message;
          }

          if (message.event === '__receivedQuery__') {
            return resolveOwnQuery(pendingQueries, message);
          }

          if (message.event === '__received__') {
            // A fan-out carries `userId`; a bare `{receivedThrough}` is this
            // client's own ack echoed back on some transports — never a fan-out
            // the client should apply, so consume it either way.
            const payload = message.payload as { userId?: unknown; receivedThrough?: unknown };
            if (
              typeof payload?.userId === 'string' &&
              typeof payload.receivedThrough === 'number'
            ) {
              applyReceived(key, payload.userId, payload.receivedThrough);
            }
            return null;
          }

          if (message.event === '__gap__') {
            const payload = message.payload as { missedThrough?: unknown } | null | undefined;
            const missedThrough = payload?.missedThrough;
            if (typeof missedThrough === 'number' && inboxScopes.has(key)) {
              const current = marks.get(key);
              if (!current) {
                marks.set(key, {
                  seq: missedThrough,
                  channel,
                  channelFamily: message.__wskit?.channelFamily,
                  acked: 0,
                });
                scheduleFlush();
              } else if (missedThrough > current.seq) {
                current.seq = missedThrough;
                scheduleFlush();
              }
            }
            return message;
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
            state.status = (messaging as { status?: ReadableStore<ChannelStatus> }).status ?? null;

            const inboxApi: ChannelInboxApi = {
              receivers: { get: state.store.store.get, subscribe: state.store.store.subscribe },
              onReceived: (callback) => {
                state.listeners.add(callback);
                return () => state.listeners.delete(callback);
              },
              receiversOf: (seq, queryOptions) =>
                runReceiptQuery(helpers, pendingQueries, {
                  scope,
                  seq,
                  event: '__receivedQuery__',
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

/** Drop members still at `0` from the received cursor map. */
function projectCursor(byUserId: ReadonlyMap<string, number>): CursorList {
  const list = new Map<string, number>();
  for (const [userId, cursor] of byUserId) {
    if (cursor > 0) list.set(userId, cursor);
  }
  return list;
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
