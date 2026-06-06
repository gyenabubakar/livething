import { UnsupportedProtocol } from '@wskit/core';
import type { WireMessage, WSKitEnvelope } from '~/internal/runtime.ts';
import type { EmptyTypeFn, Primitive } from '~/primitives/types.ts';

/**
 * Catches you up after a reconnect. As messages arrive it remembers the highest
 * sequence number (`__wskit.seq`) it has seen, per scope. When the socket
 * reconnects it asks the server for everything after that, so you don't miss
 * what happened while you were away.
 *
 * It needs `dedup()`, because the server may resend a few messages you already
 * had and dedup is what filters those out.
 */
export function replay(): Primitive<EmptyTypeFn> {
  return {
    _tag: 'replay',
    dependencies: ['dedup'],
    // Re-subscribe must reach the server before a channel's __replay__, or the
    // membership gate drops it. Order after channels when it's present.
    optionalAfter: ['channels'],
    setup(helpers) {
      // Highest seq seen per scope. The '' key is the top level; channel names
      // are their own keys so each channel catches up on its own.
      const lastSeq = new Map<string, { seq: number; channel?: string; channelScope?: string }>();

      return {
        id: 'replay',
        onIncoming(message) {
          // The server replied that it doesn't support replay (replay off, or
          // off for this scope). Warn every time so the misconfig stays visible;
          // the error still passes through to the socket's onError below.
          if (message.event === '__error__') {
            const payload = message.payload as
              | { code?: string; detail?: { event?: string } }
              | null
              | undefined;
            if (
              payload?.code === UnsupportedProtocol.code &&
              payload.detail?.event === '__replay__'
            ) {
              helpers.log.warn(
                "replay() is on the client, but the server doesn't support replay — reconnect catch-up won't work. Enable replay on the server, or remove replay() from the client.",
              );
            }
            return message;
          }

          const seq = message.__wskit?.seq;
          if (typeof seq !== 'number') return message;

          const channel = message.__wskit?.channel;
          const key = channel ?? '';
          const current = lastSeq.get(key);
          if (!current || seq > current.seq) {
            lastSeq.set(key, { seq, channel, channelScope: message.__wskit?.channelScope });
          }
          return message;
        },
        onReconnect() {
          // Nothing seen yet means nothing to catch up on.
          if (lastSeq.size === 0) return null;

          const requests: WireMessage[] = [];
          for (const info of lastSeq.values()) {
            const wskit: WSKitEnvelope = {};
            if (info.channel) {
              wskit.channel = info.channel;
              if (info.channelScope) wskit.channelScope = info.channelScope;
            }
            requests.push({
              event: '__replay__',
              payload: { lastKnownSeq: info.seq },
              __wskit: wskit,
            });
          }
          return requests;
        },
      };
    },
  };
}
