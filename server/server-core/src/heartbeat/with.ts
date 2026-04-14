import { applyFeature } from '~/_types/feature-methods.ts';
import { heartbeat as createHeartbeat } from '~/heartbeat/heartbeat.ts';
import type { BuilderInternals, ServerBuilderFull } from '~/_types/feature-methods.ts';
import type { ScopeStateShape } from '~/_types/scope-state.ts';
import type { HeartbeatOptions } from '~/heartbeat/heartbeat.ts';
import type { Primitive } from '~/primitive.ts';

const KINDS = ['server', 'group'] as const;

export function withHeartbeat<TState extends ScopeStateShape, TFeatures>(
  builder: ServerBuilderFull<TState, TFeatures>,
): ServerBuilderFull<TState, TFeatures & { heartbeat: true }> {
  applyFeature(builder, KINDS, (t) => {
    t.heartbeat = function (this: BuilderInternals, options: HeartbeatOptions) {
      this._primitives.push(createHeartbeat(options) as unknown as Primitive);
      return this;
    };
  });
  return builder as ServerBuilderFull<TState, TFeatures & { heartbeat: true }>;
}
