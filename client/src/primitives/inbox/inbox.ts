import { channelKey } from '~/internal/channel-key.ts';
import type { PrimitiveHelpers, WireMessage, WSKitEnvelope } from '~/internal/runtime.ts';
import type { InboxTypeFn } from '~/primitives/inbox/types.ts';
import type { Primitive } from '~/primitives/types.ts';

interface ScopeMark {
  seq: number;
  channel: string;
  channelFamily?: string;
  acked: number;
}

/**
 * Confirms guaranteed per-member channel delivery. As inbox messages arrive it
 * tracks the highest sequence seen per channel and acks the server with
 * `__received__`, so the server drops that member's held copy. On reconnect it
 * re-sends each channel's high-water mark, in case an ack was lost while offline.
 *
 * It learns which channels are inbox-backed from the `__wskit.inbox` flag on
 * `__subscribeOk__`, and acks only those — a plain channel's messages are never
 * acked. It needs `dedup()`, because the server re-delivers held copies on
 * reconnect and dedup filters the ones already seen. Enable inbox per channel on
 * the server; this primitive drives the client half.
 */
export function inbox(): Primitive<InboxTypeFn> {
  return {
    _tag: 'inbox',
    dependencies: ['dedup'],
    // The re-subscribe must reach the server before an ack, or the ack targets a
    // channel the reconnecting socket is not yet a member of. Running after
    // channels also lets inbox read the forwarded `__subscribeOk__` before it
    // consumes it.
    optionalAfter: ['channels'],
    setup(helpers) {
      const marks = new Map<string, ScopeMark>();
      const inboxScopes = new Set<string>();
      let flushScheduled = false;

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
            return null;
          }
          if (message.event === '__unsubscribeOk__' || message.event === '__kicked__') {
            inboxScopes.delete(key);
            marks.delete(key);
            // Forward so receipts() (after inbox) can reset its own per-channel
            // high-water mark on leave; the socket drops this protocol frame
            // before any user handler.
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

inbox.tag = 'inbox';
