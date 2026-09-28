import { channelKey } from '~/internal/channel-key.ts';
import type { LiveThingMetadata, Message } from '~/internal/runtime.ts';
import type { EmptyTypeFn, Primitive } from '~/primitives/types.ts';

/**
 * Catches you up after a reconnect. As messages arrive it remembers the highest
 * sequence number (`metadata.stream.seq` or `metadata.delivery.seq`) it has seen, per scope. When the socket
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

      function handleGap(message: Message): Message {
        const payload = message.payload as { missedThrough?: unknown } | null | undefined;
        if (typeof payload?.missedThrough === 'number') {
          remember(
            payload.missedThrough,
            message.metadata?.channel?.name,
            message.metadata?.channel?.family,
          );
        }

        return message;
      }

      function handleError(message: Message): Message {
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

      function handleIncoming(message: Message): Message {
        if (message.event === '__gap__') return handleGap(message);

        if (message.event === '__error__') return handleError(message);

        if (message.metadata?.stream?.id !== undefined) return message;

        const seq = message.metadata?.stream?.seq ?? message.metadata?.delivery?.seq;
        if (typeof seq === 'number') {
          remember(seq, message.metadata?.channel?.name, message.metadata?.channel?.family);
        }

        return message;
      }

      return {
        id: 'replay',
        onIncoming: handleIncoming,
        onReconnect() {
          if (lastSeq.size === 0) return null;

          const requests: Message[] = [];
          for (const info of lastSeq.values()) {
            const metadata: LiveThingMetadata | null = info.channel
              ? {
                  channel: {
                    name: info.channel,
                    ...(info.channelFamily ? { family: info.channelFamily } : {}),
                  },
                }
              : null;

            requests.push({
              event: '__replay__',
              payload: { lastKnownSeq: info.seq },
              metadata,
            });
          }

          return requests;
        },
      };
    },
  };
}

replay.tag = 'replay';
