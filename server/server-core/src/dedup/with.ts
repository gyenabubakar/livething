import { applyFeature } from '~/_types/feature-methods.ts';
import { dedup as createDedup } from '~/dedup/dedup.ts';
import type { BuilderInternals, ServerBuilderFull } from '~/_types/feature-methods.ts';
import type { ScopeStateShape } from '~/_types/scope-state.ts';
import type { Primitive } from '~/primitive.ts';

const KINDS = ['server', 'group'] as const;

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
