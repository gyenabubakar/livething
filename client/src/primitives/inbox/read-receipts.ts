import { channelKey } from '~/internal/channel-key.ts';
import { getAugmenters } from '~/internal/scoped.ts';
import {
  rejectPending,
  resolveOwnQuery,
  runReceiptQuery,
} from '~/primitives/inbox/receipt-query.ts';
import type { ScopeMarkers } from '~/internal/scoped.ts';
import type { PendingQuery } from '~/primitives/inbox/receipt-query.ts';
import type { ChannelReadReceiptsApi, ReadReceiptsTypeFn } from '~/primitives/inbox/types.ts';
import type { Primitive } from '~/primitives/types.ts';

/** Options for the client `readReceipts()` primitive. */
export interface ReadReceiptsOptions {
  /** Default wait for a `seenBy` answer before rejecting, in ms. Defaults to 10s; override per call. */
  timeout?: number;
}

const DEFAULT_QUERY_TIMEOUT_MS = 10_000;

/**
 * Adds read acknowledgement (the blue check) to inbox channels that opted in.
 * `markSeen(seq)` advances the server's seen cursor (omit `seq` to mark
 * everything received so far); `seenBy(seq)` asks who has read up to a sequence.
 * The delivered surface (`receipts`/`onReceipt`/`receivedBy`) belongs to
 * `inbox()`.
 */
export function readReceipts(options: ReadReceiptsOptions = {}): Primitive<ReadReceiptsTypeFn> {
  const defaultTimeout = options.timeout ?? DEFAULT_QUERY_TIMEOUT_MS;
  return {
    _tag: 'read-receipts',
    optionalAfter: ['channels', 'inbox'],
    setup(helpers) {
      // Highest non-stream seq received per channel — the `markSeen()` default.
      const ownReceived = new Map<string, number>();
      const pendingQueries = new Map<string, PendingQuery>();

      return {
        id: 'read-receipts',
        onIncoming(message) {
          const channel = message.__wskit?.channel;
          if (channel === undefined) return message;
          const key = channelKey(message.__wskit?.channelFamily, channel);

          if (message.event === '__unsubscribeOk__' || message.event === '__kicked__') {
            ownReceived.delete(key);
            return message;
          }

          if (message.event === '__receiptQuery__') {
            return resolveOwnQuery(pendingQueries, message);
          }

          if (message.event !== '__receipt__') {
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

            const readApi: ChannelReadReceiptsApi = {
              markSeen: (seq) => {
                scope.assertReady?.();
                helpers.rawSend({
                  event: '__seen__',
                  payload: { seenThrough: seq ?? ownReceived.get(key) ?? 0 },
                  __wskit: scope.markers(),
                });
              },
              seenBy: (seq, queryOptions) =>
                runReceiptQuery(helpers, pendingQueries, {
                  scope,
                  seq,
                  kind: 'seen',
                  timeout: queryOptions?.timeout ?? defaultTimeout,
                }),
            };
            Object.assign(messaging, readApi);
          });
        },
      };
    },
  };
}

function markersKey(markers: ScopeMarkers): string {
  return channelKey(markers.channelFamily, markers.channel ?? '');
}

readReceipts.tag = 'read-receipts';
