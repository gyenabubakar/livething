import { applyFeature } from '~/_builder/apply-feature.ts';
import { ack as createAck } from '~/ack/ack.ts';
import type { BuilderInternals, ServerBuilderFull } from '~/_types/feature-methods.ts';
import type { ScopeStateShape } from '~/_types/scope-state.ts';
import type { Primitive } from '~/primitive.ts';

const KINDS = ['server', 'group'] as const;

/**
 * Add acknowledgment support to a server builder.
 *
 * Once enabled, you can call `.ack()` on the builder to opt into client-side
 * acknowledgments, so clients can await confirmation that their message was
 * received and processed by the server.
 *
 * @example
 * ```ts
 * import { server } from '@wskit/server';
 *
 * const s = withAck(server('app'));
 * ```
 */
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
