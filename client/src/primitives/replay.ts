import { channelKey } from '~/internal/channel-key.ts';
import { dispatchToHandlers } from '~/internal/dispatch.ts';
import { getAugmenters } from '~/internal/scoped.ts';
import type { WireMessage, WSKitEnvelope } from '~/internal/runtime.ts';
import type { Primitive, TypeFn } from '~/primitives/types.ts';
import type { GapInfo } from '~/types.ts';

/** Adds `socket.onGap(...)` for top-level replay catch-up gaps. */
export interface ReplayTypeFn extends TypeFn {
  readonly _api: {
    /**
     * Fires when replay could not fully catch the top-level scope up after a
     * reconnect because retention had already evicted messages the client hadn't
     * seen. Channel-scoped gaps are delivered on `socket.channel(...).onGap(...)`
     * instead. Call the returned function to stop listening.
     */
    onGap(callback: (info: GapInfo) => void): () => void;
  };
}

/**
 * Catches you up after a reconnect. As messages arrive it remembers the highest
 * sequence number (`__wskit.seq`) it has seen, per scope. When the socket
 * reconnects it asks the server for everything after that, so you don't miss
 * what happened while you were away.
 *
 * It needs `dedup()`, because the server may resend a few messages you already
 * had and dedup is what filters those out.
 */
export function replay(): Primitive<ReplayTypeFn> {
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

      // Gap listeners keyed by scope like lastSeq, so a channel gap reaches only that channel's onGap.
      const gapHandlers = new Map<string, Set<(info: GapInfo) => void>>();

      function onGap(key: string, callback: (info: GapInfo) => void): () => void {
        let set = gapHandlers.get(key);
        if (!set) {
          set = new Set();
          gapHandlers.set(key, set);
        }
        set.add(callback);
        return () => {
          set.delete(callback);
          if (set.size === 0) gapHandlers.delete(key);
        };
      }

      return {
        id: 'replay',
        onIncoming(message) {
          if (message.event === '__gap__') {
            const payload = message.payload as { missedThrough?: unknown } | null | undefined;
            const missedThrough = payload?.missedThrough;
            if (typeof missedThrough === 'number') {
              const channel = message.__wskit?.channel;
              const channelFamily = message.__wskit?.channelFamily;
              const key = channel === undefined ? '' : channelKey(channelFamily, channel);
              const info: GapInfo = { missedThrough };
              if (channel !== undefined) info.channel = channel;
              if (channelFamily !== undefined) info.channelFamily = channelFamily;
              // A gap means retention pruned everything up to missedThrough, even
              // if no surviving row carried that seq. Advance the high-water mark
              // here too, or the next reconnect asks from the same stale cursor
              // and gets the same gap reported again forever.
              const current = lastSeq.get(key);
              if (!current || missedThrough > current.seq) {
                lastSeq.set(key, { seq: missedThrough, channel, channelFamily });
              }
              dispatchToHandlers(gapHandlers.get(key), helpers.log, info);
            }
            // Consume the frame so it never reaches user .on() handlers.
            return null;
          }

          // The server replied that it doesn't support replay (replay off, or
          // off for this scope). Warn every time so the misconfig stays visible;
          // the error still passes through to the socket's onServerError below.
          if (message.event === '__error__') {
            const payload = message.payload as
              | { code?: string; detail?: { event?: string } }
              | null
              | undefined;
            // Compared as a literal (not imported from core) so this primitive
            // doesn't pull the UnsupportedProtocol ErrorDef and its valibot
            // schema into the bundle just to read one code string.
            if (
              payload?.code === 'unsupported-protocol' &&
              payload.detail?.event === '__replay__'
            ) {
              helpers.log.warn(
                "replay() is on the client, but the server doesn't support replay — reconnect catch-up won't work. Enable replay on the server, or remove replay() from the client.",
              );
            }
            return message;
          }

          // Stream chunks carry their own per-stream seq, unrelated to the
          // per-scope replay sequence. Ignore them so one can't bump the replay
          // high-water mark and make reconnect catch-up skip real channel messages.
          if (message.__wskit?.streamId !== undefined) return message;

          const seq = message.__wskit?.seq;
          if (typeof seq !== 'number') return message;

          const channel = message.__wskit?.channel;
          const channelFamily = message.__wskit?.channelFamily;
          // Key by scope + name so two channels that share a name in different
          // families each catch up on their own, instead of collapsing into one.
          const key = channel === undefined ? '' : channelKey(channelFamily, channel);
          const current = lastSeq.get(key);
          if (!current || seq > current.seq) {
            lastSeq.set(key, { seq, channel, channelFamily });
          }
          return message;
        },
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
        install(socket) {
          // @ts-expect-error — install adds onGap() to the socket dynamically
          socket.onGap = (callback: (info: GapInfo) => void) => onGap('', callback);

          getAugmenters(socket).push((messaging, scope) => {
            messaging.onGap = (callback: (info: GapInfo) => void) => {
              const markers = scope.markers();
              const key =
                markers.channel === undefined
                  ? ''
                  : channelKey(markers.channelFamily, markers.channel);
              return onGap(key, callback);
            };
          });
        },
      };
    },
  };
}

replay.tag = 'replay';
