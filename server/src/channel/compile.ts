/* oxlint-disable @typescript-eslint/no-explicit-any */
import { channel as channelFactory, scope as scopeFactory } from '~/channel/channel.ts';
import {
  onBeforeSubscribe,
  onSessionEnd as onSessionEndFactory,
  onSubscribe,
  onUnsubscribe,
} from '~/channel/lifecycle.ts';
import { matchesScopePattern } from '~/channel/runtime.ts';
import { intercept as interceptFactory } from '~/intercept/intercept.ts';
import { persistentMarker } from '~/persistence/channel-marker.ts';
import { handleReplay as customReplayFactory } from '~/replay/custom/custom.ts';
import { replay as replayFactory } from '~/replay/replay.ts';
import type { BuildDefinitionsFn, HandlerMaps } from '~/_api/handler-maps.ts';
import type {
  AnyGenerate,
  AnyIncoming,
  AnyIntercept,
  AnyOutgoing,
  AnyRecordedStream,
  AnyRequest,
  AnyResumableStream,
  ChannelPrimitiveType,
  CompiledChannel,
  CompiledServer,
} from '~/_engine/compile/types.ts';
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

  const childHandlers: HandlerMaps = {
    incomingHandlers: impl?._bag.incomingHandlers ?? new Map(),
    requestHandlers: impl?._bag.requestHandlers ?? new Map(),
    streamGenerators: impl?._bag.streamGenerators ?? new Map(),
    resumableStreamGenerators: impl?._bag.resumableStreamGenerators ?? new Map(),
    recordedStreamGenerators: impl?._bag.recordedStreamGenerators ?? new Map(),
    scheduledHandlers: new Map(),
    channelImpls: new Map(),
    namespaceImpls: new Map(),
  };
  childPrimitives.push(...buildDefinitions(def.definitions, childHandlers));

  if (impl?._bag.intercept) {
    childPrimitives.push(interceptFactory(impl._bag.intercept));
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

// Engine-side: walk a built channel primitive and sort its children into the
// per-event lookup maps the runtime needs.
export function compileChannelPrimitive(primitive: ChannelPrimitiveType): CompiledChannel {
  const key = typeof primitive.pattern === 'string' ? primitive.pattern : primitive.pattern.key;
  const scope: CompiledChannel = {
    kind: 'channel',
    key,
    pattern: primitive.pattern,
    outgoing: new Map(),
    incoming: new Map(),
    requests: new Map(),
    streams: new Map(),
    resumableStreams: new Map(),
    recordedStreams: new Map(),
    intercepts: [],
  };

  for (const child of primitive.primitives) {
    switch (child.__wskit) {
      case 'outgoing':
        scope.outgoing.set((child as AnyOutgoing).event, child as AnyOutgoing);
        break;
      case 'incoming':
        scope.incoming.set((child as AnyIncoming).event, child as AnyIncoming);
        break;
      case 'request':
        scope.requests.set((child as AnyRequest).event, child as AnyRequest);
        break;
      case 'stream-generate':
        scope.streams.set((child as AnyGenerate).event, child as AnyGenerate);
        break;
      case 'resumable-stream-generate':
        scope.resumableStreams.set(
          (child as AnyResumableStream).event,
          child as AnyResumableStream,
        );
        break;
      case 'recorded-stream-generate':
        scope.recordedStreams.set((child as AnyRecordedStream).event, child as AnyRecordedStream);
        break;
      case 'intercept':
        scope.intercepts.push(child as AnyIntercept);
        break;
    }
  }

  return scope;
}

/**
 * Refuse to boot when a channel family pattern matches a static channel name.
 * The two would route the same wire `__wskit.channel` value to different compiled
 * definitions depending on which side the lookup hit first. Surface the
 * conflict at boot time to keep runtime behaviour unambiguous.
 */
export function validateChannelFamilyPatternsDisjointFromStaticNames(
  compiled: CompiledServer,
): void {
  for (const [familyKey, family] of compiled.channelFamilies) {
    for (const staticName of compiled.channels.keys()) {
      if (matchesScopePattern(family.pattern, staticName)) {
        throw new Error(
          `[wskit] Channel family '${familyKey}' has a pattern that matches the static ` +
            `channel name '${staticName}'. Static channel names and family patterns must be ` +
            `disjoint — narrow the family pattern or rename the static channel.`,
        );
      }
    }
  }
}
