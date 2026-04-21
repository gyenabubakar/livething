import { applyFeature } from '~/_builder/apply-feature.ts';
import { StreamBuilder } from '~/stream/builder.ts';
import type { BuilderInternals, ServerBuilderFull } from '~/_types/feature-methods.ts';
import type { ScopeStateShape } from '~/_types/scope-state';
import type { EventContract } from '~/event.ts';
import type { Validator } from '~/types.ts';

function streamImpl(
  parent: BuilderInternals,
  eventContract: EventContract,
  chunkSchema: Validator,
  callback: (...args: unknown[]) => unknown,
) {
  const builder = new StreamBuilder(parent, parent._primitives, eventContract, chunkSchema);
  callback(builder);
  return parent;
}

const KINDS = ['server', 'group', 'namespace', 'channel'] as const;

/**
 * Add server-to-client streaming support to a server builder.
 *
 * Once enabled, you can call `.stream()` on the builder to define streaming
 * endpoints backed by async generators, with optional nudges (client-to-server
 * signals sent mid-stream) and a broadcast mode for fan-out delivery.
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
      chunkSchema: Validator,
      callback: (...args: unknown[]) => unknown,
    ) {
      return streamImpl(this, eventContract, chunkSchema, callback);
    };
  });
  return builder as ServerBuilderFull<TState, TFeatures & { streams: true }>;
}
