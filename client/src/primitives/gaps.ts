import { channelKey } from '~/internal/channel-key.ts';
import { dispatchToHandlers } from '~/internal/dispatch.ts';
import { getAugmenters } from '~/internal/scoped.ts';
import type { ChannelTypeFn, Primitive, TypeFn } from '~/primitives/types.ts';
import type { GapInfo } from '~/types.ts';

/** The gap listener added to a socket and each channel handle. */
export interface GapsApi {
  /** Listen for a retention gap. Call the returned function to stop listening. */
  onGap(callback: (info: GapInfo) => void): () => void;
}

/** Adds `socket.onGap(...)` for top-level gaps. */
export interface GapsTypeFn extends TypeFn {
  readonly _api: GapsApi;
}

/** Adds `onGap(...)` to each channel handle. */
export interface GapsChannelTypeFn extends ChannelTypeFn {
  readonly _api: GapsApi;
}

/** The descriptor `gaps()` returns. */
export type GapsPrimitive = Primitive<GapsTypeFn, {}, GapsChannelTypeFn>;

/** Surfaces retention gaps without tying them to the feature that produced them. */
export function gaps(): GapsPrimitive {
  return {
    _tag: 'gaps',
    optionalAfter: ['channels', 'inbox', 'replay'],
    setup(helpers) {
      const handlers = new Map<string, Set<(info: GapInfo) => void>>();

      function onGap(key: string, callback: (info: GapInfo) => void): () => void {
        let scopedHandlers = handlers.get(key);
        if (!scopedHandlers) {
          scopedHandlers = new Set();
          handlers.set(key, scopedHandlers);
        }

        scopedHandlers.add(callback);
        let active = true;

        return () => {
          if (!active) return;

          active = false;
          scopedHandlers.delete(callback);
          if (scopedHandlers.size === 0 && handlers.get(key) === scopedHandlers) {
            handlers.delete(key);
          }
        };
      }

      return {
        id: 'gaps',
        onIncoming(message) {
          if (message.event !== '__gap__') return message;

          const missedThrough = (message.payload as { missedThrough?: unknown } | null | undefined)
            ?.missedThrough;
          if (typeof missedThrough === 'number') {
            const channel = message.metadata?.channel?.name;
            const channelFamily = message.metadata?.channel?.family;
            const key = channel === undefined ? '' : channelKey(channelFamily, channel);
            const info: GapInfo = { missedThrough };
            if (channel !== undefined) info.channel = channel;

            if (channelFamily !== undefined) info.channelFamily = channelFamily;
            dispatchToHandlers(handlers.get(key), helpers.log, info);
          }

          return null;
        },
        install(socket) {
          // @ts-expect-error — install adds onGap() to the socket dynamically
          socket.onGap = (callback: (info: GapInfo) => void) => onGap('', callback);

          getAugmenters(socket).push((messaging, scope) => {
            messaging.onGap = (callback: (info: GapInfo) => void) => {
              const markers = scope.markers();
              const key =
                markers.name === undefined ? '' : channelKey(markers.family, markers.name);
              return onGap(key, callback);
            };
          });
        },
      };
    },
  };
}

gaps.tag = 'gaps';
