/* oxlint-disable @typescript-eslint/no-explicit-any */
import { channel as channelFactory, scope as scopeFactory } from '~/channel/channel.ts';
import {
  onBeforeSubscribe,
  onSessionEnd as onSessionEndFactory,
  onSubscribe,
  onUnsubscribe,
} from '~/channel/lifecycle.ts';
import { intercept as interceptFactory } from '~/intercept/intercept.ts';
import { persistentMarker } from '~/persistence/channel-marker.ts';
import { handleReplay as customReplayFactory } from '~/replay/custom/custom.ts';
import { replay as replayFactory } from '~/replay/replay.ts';
import type { BuildDefinitionsFn, HandlerMaps } from '~/_api/handler-maps.ts';
import type { ScopeDeclaration } from '~/channel/channel.ts';
import type { ChannelDef } from '~/channel/definition.ts';
import type { ChannelImplement } from '~/channel/implement.ts';
import type { Primitive } from '~/primitive.ts';

export function compileChannelDef(
  def: ChannelDef,
  channelImpls: Map<string, ChannelImplement<any, any>>,
  buildDefinitions: BuildDefinitionsFn,
): Primitive {
  const patternKey =
    typeof def.pattern === 'string' ? def.pattern : (def.pattern as ScopeDeclaration).key;
  // A channel can be declaration-only with no handlers attached, so impl
  // may be undefined.
  const impl = channelImpls.get(patternKey);

  const childPrimitives: Primitive[] = [];

  if (def.persistent !== undefined) {
    childPrimitives.push(persistentMarker(def.persistent));
  }

  // Built-in replay set via the contract. Custom replay goes through
  // ch.customReplay() and is handled separately below.
  if (def.replay !== undefined) {
    if (def.replay === false) {
      childPrimitives.push(replayFactory(false));
    } else if (def.replay === true) {
      childPrimitives.push(replayFactory());
    } else {
      childPrimitives.push(replayFactory(def.replay as any));
    }
  }

  if (impl?._bag.customReplayHooks) {
    childPrimitives.push(customReplayFactory(impl._bag.customReplayHooks as any));
  }

  // Walk the channel's own definitions, with handlers scoped to this channel.
  const childHandlers: HandlerMaps = {
    incomingHandlers: impl?._bag.incomingHandlers ?? new Map(),
    requestHandlers: impl?._bag.requestHandlers ?? new Map(),
    streamGenerators: impl?._bag.streamGenerators ?? new Map(),
    scheduledHandlers: new Map(),
    channelImpls: new Map(),
    namespaceImpls: new Map(),
  };
  childPrimitives.push(...buildDefinitions(def.definitions, childHandlers));

  if (impl?._bag.preIntercept) {
    childPrimitives.push(interceptFactory(impl._bag.preIntercept));
  }
  if (impl) {
    for (const [event, handler] of impl._bag.postIntercepts) {
      childPrimitives.push(interceptFactory(event, handler));
    }
  }

  if (impl?._bag.onBeforeSubscribeHandler) {
    childPrimitives.push(onBeforeSubscribe(impl._bag.onBeforeSubscribeHandler));
  }
  if (impl?._bag.onSubscribeHandler) {
    childPrimitives.push(onSubscribe(impl._bag.onSubscribeHandler));
  }
  if (impl?._bag.onUnsubscribeHandler) {
    childPrimitives.push(onUnsubscribe(impl._bag.onUnsubscribeHandler));
  }
  if (impl?._bag.onSessionEndHandler) {
    childPrimitives.push(onSessionEndFactory(impl._bag.onSessionEndHandler));
  }

  // Pattern can be a plain string or a scope() declaration.
  const pattern =
    typeof def.pattern === 'string'
      ? def.pattern
      : scopeFactory(
          (def.pattern as ScopeDeclaration).key,
          (def.pattern as ScopeDeclaration).pattern,
        );
  return channelFactory(pattern as any, ...(childPrimitives as any[]));
}
