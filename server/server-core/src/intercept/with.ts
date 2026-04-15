import { applyFeature } from '~/_builder/apply-feature.ts';
import { intercept as createIntercept } from '~/intercept/intercept.ts';
import type { BuilderInternals, ServerBuilderFull } from '~/_types/feature-methods.ts';
import type { ScopeStateShape } from '~/_types/scope-state.ts';
import type { Primitive } from '~/primitive.ts';

const KINDS = ['server', 'group', 'channel'] as const;

function isEventContract(value: unknown): value is { event: string } {
  return typeof value === 'object' && value !== null && 'event' in value;
}

export function withIntercept<TState extends ScopeStateShape, TFeatures>(
  builder: ServerBuilderFull<TState, TFeatures>,
): ServerBuilderFull<TState, TFeatures & { intercept: true }> {
  applyFeature(builder, KINDS, (t) => {
    t.intercept = function (
      this: BuilderInternals,
      firstArg: string | { event: string } | ((...args: never[]) => unknown),
      secondArg?: (...args: never[]) => unknown,
    ) {
      const factory = createIntercept as (...args: unknown[]) => Primitive;
      if (typeof firstArg === 'string') {
        this._primitives.push(factory(firstArg, secondArg));
      } else if (isEventContract(firstArg)) {
        this._primitives.push(factory(firstArg.event, secondArg));
      } else {
        this._primitives.push(factory(firstArg));
      }
      return this;
    };
  });
  return builder as ServerBuilderFull<TState, TFeatures & { intercept: true }>;
}
