import { ChannelNotFound } from '@livething/core';
import * as ChannelPrimitive from '~/channel/runtime.ts';
import type * as EngineCompileTypes from '~/_engine/compile/types.ts';
import type * as Protocol from '~/_engine/runtime/protocol.ts';
import type * as EngineRuntimeTypes from './types.ts';

/**
 * Read routing markers from a frame's `__livething` block and resolve the active
 * channel.
 */
export function resolveChannel(
  compiled: EngineCompileTypes.CompiledServer,
  livething: Protocol.LiveThingProtocol | undefined,
): EngineRuntimeTypes.ResolvedChannel {
  if (!livething) return {};

  if (livething.channel !== undefined) {
    if (livething.channelFamily !== null) {
      const family = compiled.channelFamilies.get(livething.channelFamily);
      if (!family) throw ChannelNotFound();

      if (!ChannelPrimitive.matchesFamilyPattern(family.pattern, livething.channel)) {
        throw ChannelNotFound();
      }

      return {
        channel: family,
        channelName: livething.channel,
        channelFamily: livething.channelFamily,
      };
    }

    const channel = compiled.channels.get(livething.channel);
    if (!channel) throw ChannelNotFound();

    return {
      channel,
      channelName: livething.channel,
      channelFamily: null,
    };
  }

  return {};
}

/**
 * Pick the routing markers off a frame's `__livething` block so they can ride
 * along on a server-side `__error__` frame and the client can correlate the
 * failure with its pending operation.
 */
export function routingFromLiveThing(
  livething: Protocol.LiveThingRouting | undefined,
): Protocol.LiveThingRouting | undefined {
  if (!livething) return undefined;

  const routing: Protocol.LiveThingRouting = {};
  if (livething.correlationId !== undefined) routing.correlationId = livething.correlationId;
  // Echo a client-originated exchange's source so an error reply to a client
  // request carries `source: 'client'`, matching the success reply. Only
  // 'client' is echoed: a server-originated frame's error must not come back
  // looking like a fresh server→client request.
  if (livething.source === 'client') routing.source = 'client';
  if (livething.streamId !== undefined) routing.streamId = livething.streamId;
  if (livething.streamNudgeId !== undefined) routing.streamNudgeId = livething.streamNudgeId;
  if (livething.uploadId !== undefined) routing.uploadId = livething.uploadId;
  if (livething.channel !== undefined) {
    routing.channel = livething.channel;
    routing.channelFamily = livething.channelFamily ?? null;
  }

  return Object.keys(routing).length > 0 ? routing : undefined;
}
