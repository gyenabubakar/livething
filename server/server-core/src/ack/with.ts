import { applyFeature } from '~/_types/feature-methods.ts';
import { ack as createAck } from '~/ack/ack.ts';
import type { BuilderInternals, ServerBuilderFull } from '~/_types/feature-methods.ts';
import type { ScopeStateShape } from '~/_types/scope-state.ts';
import type { Primitive } from '~/primitive.ts';

const KINDS = ['server', 'group'] as const;

export function withAck<TState extends ScopeStateShape, TFeatures>(
  builder: ServerBuilderFull<TState, TFeatures>,
): ServerBuilderFull<TState, TFeatures & { ack: true }> {
  applyFeature(builder, KINDS, (t) => {
    t.ack = function (this: BuilderInternals) {
      this._primitives.push(createAck() as unknown as Primitive);
      return this;
    };
  });
  return builder as ServerBuilderFull<TState, TFeatures & { ack: true }>;
}
