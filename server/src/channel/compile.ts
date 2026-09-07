/* oxlint-disable @typescript-eslint/no-explicit-any */
import { setUniqueOrThrow } from '~/_engine/compile/utils.ts';
import { matchesFamilyPattern } from '~/channel/runtime.ts';
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
    __plugin: (primitive as { __plugin?: string }).__plugin,
  };

  const scopeLabel = `channel "${key}"`;
  for (const child of primitive.primitives) {
    switch (child.__wskit) {
      case 'outgoing': {
        const p = child as AnyOutgoing;
        setUniqueOrThrow(scope.outgoing, p.event, { value: p, kind: `outgoing in ${scopeLabel}` });
        break;
      }

      case 'incoming': {
        const p = child as AnyIncoming;
        setUniqueOrThrow(scope.incoming, p.event, { value: p, kind: `incoming in ${scopeLabel}` });
        break;
      }

      case 'request': {
        const p = child as AnyRequest;
        setUniqueOrThrow(scope.requests, p.event, { value: p, kind: `request in ${scopeLabel}` });
        break;
      }

      case 'stream-generate': {
        const p = child as AnyGenerate;
        setUniqueOrThrow(scope.streams, p.event, { value: p, kind: `stream in ${scopeLabel}` });
        break;
      }

      case 'resumable-stream-generate': {
        const p = child as AnyResumableStream;
        setUniqueOrThrow(scope.resumableStreams, p.event, {
          value: p,
          kind: `resumableStream in ${scopeLabel}`,
        });
        break;
      }

      case 'recorded-stream-generate': {
        const p = child as AnyRecordedStream;
        setUniqueOrThrow(scope.recordedStreams, p.event, {
          value: p,
          kind: `recordedStream in ${scopeLabel}`,
        });
        break;
      }

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
      if (matchesFamilyPattern(family.pattern, staticName)) {
        throw new Error(
          `[wskit] Channel family '${familyKey}' has a pattern that matches the static ` +
            `channel name '${staticName}'. Static channel names and family patterns must be ` +
            `disjoint — narrow the family pattern or rename the static channel.`,
        );
      }
    }
  }
}
