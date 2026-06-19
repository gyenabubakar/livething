import { ChannelNotFound } from '@wskit/core';
import * as ChannelPrimitive from '~/channel/runtime.ts';
import type * as EngineCompileTypes from '~/_engine/compile/types.ts';
import type * as Protocol from '~/_engine/runtime/protocol.ts';
import type * as EngineRuntimeTypes from './types.ts';

/**
 * Read routing markers from a frame's `__wskit` block and resolve the active
 * scope.
 */
export function resolveScope(
  compiled: EngineCompileTypes.CompiledServer,
  wskit: Protocol.WSKitProtocol | undefined,
): EngineRuntimeTypes.ResolvedScope {
  if (!wskit) return {};

  if (wskit.channel !== undefined) {
    if (wskit.channelScope !== null) {
      const family = compiled.channelFamilies.get(wskit.channelScope);
      if (!family) throw ChannelNotFound();
      if (!ChannelPrimitive.matchesScopePattern(family.pattern, wskit.channel)) {
        throw ChannelNotFound();
      }
      return {
        channel: family,
        channelName: wskit.channel,
        channelScope: wskit.channelScope,
      };
    }

    const channel = compiled.channels.get(wskit.channel);
    if (!channel) throw ChannelNotFound();
    return {
      channel,
      channelName: wskit.channel,
      channelScope: null,
    };
  }

  return {};
}

/**
 * Pick the routing markers off a frame's `__wskit` block so they can ride
 * along on a server-side `__error__` frame and the client can correlate the
 * failure with its pending operation.
 */
export function routingFromWSKit(
  wskit: Protocol.WSKitRouting | undefined,
): Protocol.WSKitRouting | undefined {
  if (!wskit) return undefined;
  const routing: Protocol.WSKitRouting = {};
  if (wskit.correlationId !== undefined) routing.correlationId = wskit.correlationId;
  // Echo a client-originated exchange's source so an error reply to a client
  // request carries `source: 'client'`, matching the success reply. Only
  // 'client' is echoed: a server-originated frame's error must not come back
  // looking like a fresh server→client request.
  if (wskit.source === 'client') routing.source = 'client';
  if (wskit.streamId !== undefined) routing.streamId = wskit.streamId;
  if (wskit.streamNudgeId !== undefined) routing.streamNudgeId = wskit.streamNudgeId;
  if (wskit.channel !== undefined) {
    routing.channel = wskit.channel;
    routing.channelScope = wskit.channelScope ?? null;
  }
  return Object.keys(routing).length > 0 ? routing : undefined;
}
