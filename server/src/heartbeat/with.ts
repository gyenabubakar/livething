import { applyFeature } from '~/_builder/apply-feature.ts';
import { heartbeat as createHeartbeat } from '~/heartbeat/heartbeat.ts';
import type { BuilderInternals, ServerBuilderFull } from '~/_types/feature-methods.ts';
import type { ScopeStateShape } from '~/_types/scope-state';
import type { HeartbeatOptions } from '~/heartbeat/heartbeat.ts';
import type { Primitive } from '~/primitive.ts';

const KINDS = ['server', 'group'] as const;

/**
 * Add heartbeat support to a server builder.
 *
 * Once enabled, you can call `.heartbeat({ timeout })` on the builder to arm
 * an idle-close timer: if no client activity arrives within `timeout` ms, the
 * connection is closed with `CloseCodes.IDLE`. Latency and connection-quality
 * tracking are already on by default and do not require this primitive.
 *
 * @example
 * ```ts
 * import { server } from '@wskit/server';
 *
 * const s = withHeartbeat(server('app'));
 * // later: s.heartbeat({ timeout: 30_000 })
 * ```
 */
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
