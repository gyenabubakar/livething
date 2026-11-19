import { LiveThingConfigError } from '@livething/core';
import { ENGINE_CHANNEL_META } from '~/_engine/contexts/contexts.ts';
import { createAwarenessRuntime } from '~/awareness/runtime.ts';
import type { EngineChannelMeta } from '~/_engine/contexts/types.ts';
import type { AwarenessOptions } from '~/awareness/runtime.ts';
import type { Primitive } from '~/primitive.ts';

/** The TypeScript type returned by `awarenessMarker(options)`. */
export interface AwarenessMarkerPrimitive extends Primitive<'awareness-marker'> {
  readonly options: AwarenessOptions;
}

const AWARENESS_MARKER_KEY = Symbol('awareness-marker');

/** Room for the event name, the channel routing and the JSON around a state. */
const HEADER_ROOM = 4096;
/** The 5-byte header of a batched `http()` POST. */
const POST_HEADER = 5;
const MAX_PIECE_BYTES = 256 * 1024;

/**
 * Channel-scope marker built by `awareness()` from the channel's `awareness` option: checks the options against the channel and
 * the adapter's message limits, turns the engine's awareness runtime on for the channel,
 * and adds `ctx.channel.awareness`.
 *
 * @internal
 */
export function awarenessMarker(awarenessOptions: AwarenessOptions): AwarenessMarkerPrimitive {
  return {
    __livething: 'awareness-marker',
    __identity: [AWARENESS_MARKER_KEY],
    __requires: {},
    options: awarenessOptions,
    __validate(view) {
      // Awareness sends each member's `meta` to the channel, and `presence: false` is how an
      // app keeps `meta` from members.
      if (view.channelKey && !view.hasPresence(view.channelKey)) {
        throw new LiveThingConfigError(
          `channel '${view.channelKey}': awareness() needs presence. It sends each member's meta to the channel, and 'presence: false' keeps meta private.`,
        );
      }
    },
    // Reads `this.options`, not the closure: a plugin channel hands in a copy with its check scoped.
    __setup(this: AwarenessMarkerPrimitive, engine) {
      const { options } = this;
      const { channelKey } = engine.getScopeInfo();
      if (!channelKey) return;

      const context = `channel '${channelKey}'`;

      const { receiveBytes, sendBytes, postBytes } = engine.getMessageLimits();
      const needed = options.maxBytes + HEADER_ROOM;
      const pieceBytes = Math.min(Math.floor(sendBytes / 2), MAX_PIECE_BYTES);
      for (const [limit, name] of [
        [receiveBytes, 'receive limit'],
        [pieceBytes, 'half of its send limit'],
      ] as const) {
        if (needed > limit) {
          throw new LiveThingConfigError(
            `${context}: the awareness 'maxBytes' (${options.maxBytes}) does not fit the adapter's ${name} (${limit} bytes) with room for the frame's header. Lower 'maxBytes' or raise the limit.`,
          );
        }
      }

      if (postBytes !== undefined && needed + POST_HEADER > postBytes) {
        throw new LiveThingConfigError(
          `${context}: the awareness 'maxBytes' (${options.maxBytes}) does not fit http() maxPostBytes (${postBytes} bytes) with room for the frame's header. Lower 'maxBytes' or raise maxPostBytes.`,
        );
      }

      const runtime = engine.enableAwareness(channelKey, options, createAwarenessRuntime);

      engine.extendContext((baseCtx) => {
        const ctx = baseCtx as {
          channel?: Record<PropertyKey, unknown>;
          [ENGINE_CHANNEL_META]?: EngineChannelMeta;
        };
        const scope = ctx[ENGINE_CHANNEL_META];
        if (
          !ctx.channel ||
          scope?.isSubscribeGate ||
          scope?.channelName === undefined ||
          (scope.channelFamily ?? scope.channelName) !== channelKey
        ) {
          return {};
        }

        ctx.channel.awareness = runtime.surface(
          { channelName: scope.channelName, channelFamily: scope.channelFamily ?? null },
          { canSet: !scope.isAwarenessCheck },
        );

        return {};
      });
    },
  };
}
