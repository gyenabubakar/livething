import { channelKey } from '~/internal/channel-key.ts';
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
    // The re-subscribe message must arrive before __replay__, or the server
    // rejects it (not yet a member). Order after channels when it's present.
    optionalAfter: ['channels', 'inbox'],
    setup(helpers) {
      // Highest seq seen per scope. The '' key is the top level; channel names
      // are their own keys so each channel catches up on its own.
      const lastSeq = new Map<string, { seq: number; channel?: string; channelFamily?: string }>();

      function remember(
        seq: number,
        channel: string | undefined,
        channelFamily: string | undefined,
      ): void {
        const key = channel === undefined ? '' : channelKey(channelFamily, channel);
        const current = lastSeq.get(key);
        if (!current || seq > current.seq) lastSeq.set(key, { seq, channel, channelFamily });
      }

      function handleGap(message: WireMessage): WireMessage {
        const payload = message.payload as { missedThrough?: unknown } | null | undefined;
        if (typeof payload?.missedThrough === 'number') {
          remember(payload.missedThrough, message.__wskit?.channel, message.__wskit?.channelFamily);
        }

        return message;
      }

      function handleError(message: WireMessage): WireMessage {
        const payload = message.payload as
          | { code?: string; detail?: { event?: string } }
          | null
          | undefined;
        if (payload?.code === 'unsupported-protocol' && payload.detail?.event === '__replay__') {
          helpers.log.warn(
            "replay() is on the client, but the server doesn't support replay — reconnect catch-up won't work. Enable replay on the server, or remove replay() from the client.",
          );
        }

        return message;
      }

      function handleIncoming(message: WireMessage): WireMessage {
        if (message.event === '__gap__') return handleGap(message);

        if (message.event === '__error__') return handleError(message);

        if (message.__wskit?.streamId !== undefined) return message;

        const seq = message.__wskit?.seq;
        if (typeof seq === 'number') {
          remember(seq, message.__wskit?.channel, message.__wskit?.channelFamily);
        }

        return message;
      }

      return {
        id: 'replay',
        onIncoming: handleIncoming,
        onReconnect() {
          if (lastSeq.size === 0) return null;

          const requests: WireMessage[] = [];
          for (const info of lastSeq.values()) {
            const wskit: WSKitEnvelope = {};
            if (info.channel) {
              wskit.channel = info.channel;
              if (info.channelFamily) wskit.channelFamily = info.channelFamily;
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

replay.tag = 'replay';
