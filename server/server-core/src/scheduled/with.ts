import { applyFeature } from '~/_builder/apply-feature.ts';
import { scheduled as createScheduled } from '~/scheduled/scheduled.ts';
import type { BuilderInternals, ServerBuilderFull } from '~/_types/feature-methods.ts';
import type { ScopeStateShape } from '~/_types/scope-state.ts';
import type { Primitive } from '~/primitive.ts';

const KINDS = ['server', 'group'] as const;

export function withScheduled<TState extends ScopeStateShape, TFeatures>(
  builder: ServerBuilderFull<TState, TFeatures>,
): ServerBuilderFull<TState, TFeatures & { scheduled: true }> {
  applyFeature(builder, KINDS, (t) => {
    t.scheduled = function (
      this: BuilderInternals,
      taskId: string,
      handlerOrSchema: unknown,
      options?: unknown,
    ) {
      const factory = createScheduled as (...args: unknown[]) => Primitive;
      this._primitives.push(factory(taskId, handlerOrSchema, options));
      return this;
    };
  });
  return builder as ServerBuilderFull<TState, TFeatures & { scheduled: true }>;
}
