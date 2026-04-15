import { applyFeature } from '~/_builder/apply-feature.ts';
import { hibernation as createHibernation } from '~/hibernation/hibernation.ts';
import type { BuilderInternals, ServerBuilderFull } from '~/_types/feature-methods.ts';
import type { ScopeStateShape } from '~/_types/scope-state.ts';
import type { Primitive } from '~/primitive.ts';

const KINDS = ['server', 'group'] as const;

export function withHibernation<TState extends ScopeStateShape, TFeatures>(
  builder: ServerBuilderFull<TState, TFeatures>,
): ServerBuilderFull<TState, TFeatures & { hibernation: true }> {
  applyFeature(builder, KINDS, (t) => {
    t.hibernation = function (this: BuilderInternals, enabled?: boolean) {
      this._primitives.push(createHibernation(enabled) as unknown as Primitive);
      return this;
    };
  });
  return builder as ServerBuilderFull<TState, TFeatures & { hibernation: true }>;
}
