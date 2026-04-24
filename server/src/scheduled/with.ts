import { applyFeature } from '~/_builder/apply-feature.ts';
import { scheduled as createScheduled } from '~/scheduled/scheduled.ts';
import type { BuilderInternals, ServerBuilderFull } from '~/_types/feature-methods.ts';
import type { ScopeStateShape } from '~/_types/scope-state';
import type { Primitive } from '~/primitive.ts';

const KINDS = ['server', 'group'] as const;

/**
 * Add scheduled task support to a server builder.
 *
 * Once enabled, you can call `.scheduled()` on the builder to register tasks
 * that run at a specific time or on a recurring interval. Inside the callback,
 * configure task data, recurrence, and retry behavior before calling `.run(...)`.
 *
 * @example
 * ```ts
 * import { server } from '@wskit/server';
 *
 * const s = withScheduled(server('app'));
 * ```
 */
export function withScheduled<TState extends ScopeStateShape, TFeatures>(
  builder: ServerBuilderFull<TState, TFeatures>,
): ServerBuilderFull<TState, TFeatures & { scheduled: true }> {
  applyFeature(builder, KINDS, (t) => {
    t.scheduled = function (
      this: BuilderInternals,
      taskId: string,
      callback: (...args: unknown[]) => unknown,
    ) {
      const factory = createScheduled as (...args: unknown[]) => Primitive;
      this._primitives.push(factory(taskId, callback));
      return this;
    };
  });
  return builder as ServerBuilderFull<TState, TFeatures & { scheduled: true }>;
}
