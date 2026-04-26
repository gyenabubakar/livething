import { applyFeature } from '~/_builder/apply-feature.ts';
import { dedup as createDedup } from '~/dedup/dedup.ts';
import type { BuilderInternals, ServerBuilderFull } from '~/_types/feature-methods.ts';
import type { ScopeStateShape } from '~/_types/scope-state';
import type { Primitive } from '~/primitive.ts';

const KINDS = ['server'] as const;

/**
 * Add message deduplication support to a server builder.
 *
 * Once enabled, you can call `.dedup()` on the builder to turn on
 * deduplication. Every outgoing message is stamped with a unique id so
 * clients can drop duplicates, and incoming messages with a repeated id are
 * silently discarded before handlers run.
 *
 * @example
 * ```ts
 * import { server } from '@wskit/server';
 *
 * const s = withDedup(server('app'));
 * ```
 */
export function withDedup<TState extends ScopeStateShape, TFeatures>(
  builder: ServerBuilderFull<TState, TFeatures>,
): ServerBuilderFull<TState, TFeatures & { dedup: true }> {
  applyFeature(builder, KINDS, (t) => {
    t.dedup = function (this: BuilderInternals) {
      this._primitives.push(createDedup() as unknown as Primitive);
      return this;
    };
  });
  return builder as ServerBuilderFull<TState, TFeatures & { dedup: true }>;
}
