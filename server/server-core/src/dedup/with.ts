import { applyFeature } from '~/_builder/apply-feature.ts';
import { dedup as createDedup } from '~/dedup/dedup.ts';
import type { BuilderInternals, ServerBuilderFull } from '~/_types/feature-methods.ts';
import type { ScopeStateShape } from '~/_types/scope-state.ts';
import type { Primitive } from '~/primitive.ts';

const KINDS = ['server', 'group'] as const;

/**
 * Add message deduplication support to a server builder.
 *
 * Once enabled, you can call `.dedup()` on the builder to turn on
 * deduplication. The engine will assign a unique `_messageId` to every
 * outgoing message and silently discard any duplicate deliveries on the
 * client side.
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
