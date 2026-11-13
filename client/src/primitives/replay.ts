import { channelKey } from '~/internal/channel-key.ts';
import type { LiveThingMetadata, Message } from '~/internal/runtime.ts';
import type { EmptyTypeFn, Primitive, PrimitiveIdentity } from '~/primitives/types.ts';

/** How many past connections' resume tokens are kept; the server accepts at most this many. */
const MAX_RESUME_TOKENS = 8;

/**
 * Catches you up after a reconnect. As messages arrive it remembers the highest
 * sequence number (`metadata.stream.seq` or `metadata.delivery.seq`) it has seen, per scope. When the socket
 * reconnects it asks the server for everything after that, so you don't miss
 * what happened while you were away.
 *
 * Each connection also gets a secret resume token from the server
 * (`__resume__`). The request shows the tokens of the last few connections, so
 * the server also resends what it sent to those connections only (`ctx.send`,
 * a tag, a connection ref).
 *
 * It needs `dedup()`, because the server may resend a few messages you already
 * had and dedup is what filters those out.
 */
export function replay(): Primitive<EmptyTypeFn> & PrimitiveIdentity<'replay', 'dedup'> {
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
      const resumeTokens: string[] = [];

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

      function handleIncoming(message: Message): Message | null {
        if (message.event === '__resume__') {
          const payload = message.payload as { token?: unknown; seq?: unknown } | null;
          if (typeof payload?.token === 'string') {
            resumeTokens.push(payload.token);
            if (resumeTokens.length > MAX_RESUME_TOKENS) resumeTokens.shift();
          }

          // The seq is where this connection started: a cursor for a client that
          // has seen no frame yet. A cursor it already has is never moved forward.
          if (typeof payload?.seq === 'number' && !lastSeq.has('')) {
            remember(payload.seq, undefined, undefined);
          }

          return null;
        }

        // Same for a channel: a cursor for a member that hears nothing before a drop.
        if (message.event === '__subscribeOk__') {
          const seq = (message.payload as { seq?: unknown } | null)?.seq;
          const channel = message.metadata?.channel;
          if (
            typeof seq === 'number' &&
            channel &&
            !lastSeq.has(channelKey(channel.family, channel.name))
          ) {
            remember(seq, channel.name, channel.family);
          }

          return message;
        }

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
              payload:
                resumeTokens.length > 0
                  ? { lastKnownSeq: info.seq, resume: [...resumeTokens] }
                  : { lastKnownSeq: info.seq },
              metadata,
            });
          }

          return requests;
        },
      };
    },
  };
}

replay.tag = 'replay' as const;
