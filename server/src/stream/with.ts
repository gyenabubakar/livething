import { applyFeature } from '~/_builder/apply-feature.ts';
import { StreamBuilder } from '~/stream/builder.ts';
import type { BuilderInternals, ServerBuilderFull } from '~/_types/feature-methods.ts';
import type { ScopeStateShape } from '~/_types/scope-state';
import type { EventContract } from '~/event.ts';

function streamImpl(
  parent: BuilderInternals,
  eventContract: EventContract,
  callback: (...args: unknown[]) => unknown,
) {
  const builder = new StreamBuilder(parent, parent._primitives, eventContract);
  callback(builder);
  return parent;
}

const KINDS = ['server', 'group', 'namespace', 'channel'] as const;

/**
 * Add server-to-client streaming support to a server builder.
 *
 * Once enabled, you can call `.stream()` on the builder to define streaming
 * endpoints backed by async generators. Inside the callback, call `.chunk()`
 * to declare the chunk shape, then optionally add nudges and broadcast mode
 * before `.generate()`.
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
  applyFeature(builder, KINDS, (t) => {
    t.stream = function (
      this: BuilderInternals,
      eventContract: EventContract,
      callback: (...args: unknown[]) => unknown,
    ) {
      return streamImpl(this, eventContract, callback);
    };
  });
  return builder as ServerBuilderFull<TState, TFeatures & { streams: true }>;
}
