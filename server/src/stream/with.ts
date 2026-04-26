import { StreamBuilder } from '~/stream/builder.ts';
import type { BuilderInternals, ServerBuilderFull } from '~/_types/feature-methods.ts';
import type { ScopeStateShape } from '~/_types/scope-state';
import type { EventContract } from '~/event.ts';
import type { Primitive } from '~/primitive.ts';

const STREAM_BUNDLE_KEY = Symbol('stream-bundle');

/**
 * Build the wrapper primitive a server-level `.stream(...)` call returns. The
 * wrapper carries `__wskit: 'group'` so `.use(streamPrim)` expands its inner
 * primitives onto the parent builder using the same code path groups use.
 */
function makeStreamBundle(eventName: string, primitives: readonly Primitive[]): Primitive {
  return {
    __wskit: 'group' as const,
    __kind: 'scope' as const,
    __identity: [STREAM_BUNDLE_KEY, eventName] as const,
    __dependencies: [],
    __requires: {},
    primitives,
    /* oxlint-disable-next-line @typescript-eslint/no-explicit-any */
  } as any;
}

/**
 * Server-level `.stream(...)` runs the user's callback against a `StreamBuilder`
 * with a fresh primitives array, then returns the collected primitives as a
 * single `.use()`-able bundle. The parent builder is not mutated.
 */
function streamServerImpl(
  parent: BuilderInternals,
  eventContract: EventContract,
  callback: (...args: unknown[]) => unknown,
): Primitive {
  const tempPrimitives: Primitive[] = [];
  const builder = new StreamBuilder(parent, tempPrimitives, eventContract);
  callback(builder);
  return makeStreamBundle(eventContract.event, tempPrimitives);
}

/**
 * Sub-builder `.stream(...)` (inside `.namespace(...)` or `.channel(...)`) keeps
 * the original auto-seal behavior: stream primitives are pushed onto the parent
 * sub-builder's primitives so they ship as part of that namespace or channel
 * bundle. Returns the parent so chaining continues.
 */
function streamSubBuilderImpl(
  parent: BuilderInternals,
  eventContract: EventContract,
  callback: (...args: unknown[]) => unknown,
): BuilderInternals {
  const builder = new StreamBuilder(parent, parent._primitives, eventContract);
  callback(builder);
  return parent;
}

/**
 * Add server-to-client streaming support to a server builder.
 *
 * Once enabled, you can call `.stream()` on the builder to define streaming
 * endpoints backed by async generators. Inside the callback, call `.chunk()`
 * to declare the chunk shape, then optionally add nudges and broadcast mode
 * before `.generate()`.
 *
 * At server level `.stream(...)` returns a primitive — capture it and mount
 * it on a builder with `.use(streamPrim)` to register the endpoint. Inside
 * `.namespace(...)` or `.channel(...)` `.stream(...)` chains instead, attaching
 * the stream to that scope.
 *
 * @example
 * ```ts
 * import { server } from '@wskit/server';
 *
 * const s = withStreams(server('app'));
 * ```
 */
export function withStreams<TState extends ScopeStateShape, TFeatures>(
  builder: ServerBuilderFull<TState, TFeatures>,
): ServerBuilderFull<TState, TFeatures & { streams: true }> {
  /* oxlint-disable @typescript-eslint/no-explicit-any */
  (builder as any).stream = function (
    this: BuilderInternals,
    eventContract: EventContract,
    callback: (...args: unknown[]) => unknown,
  ) {
    return streamServerImpl(this, eventContract, callback);
  };
  builder._featureApplicators.push((target, kind) => {
    if (kind === 'namespace' || kind === 'channel') {
      (target as any).stream = function (
        this: BuilderInternals,
        eventContract: EventContract,
        callback: (...args: unknown[]) => unknown,
      ) {
        return streamSubBuilderImpl(this, eventContract, callback);
      };
    }
  });
  /* oxlint-enable @typescript-eslint/no-explicit-any */
  return builder as ServerBuilderFull<TState, TFeatures & { streams: true }>;
}
