import { applyFeature } from '~/_builder/apply-feature.ts';
import { sequence as createSequence } from '~/sequence/sequence.ts';
import type { BuilderInternals, ServerBuilderFull } from '~/_types/feature-methods.ts';
import type { ScopeStateShape } from '~/_types/scope-state.ts';
import type { Primitive } from '~/primitive.ts';
import type { SequenceOptions } from '~/sequence/sequence.ts';

const KINDS = ['server', 'group'] as const;

/**
 * Add sequential message numbering to a server builder.
 *
 * Once enabled, you can call `.sequence()` on the builder to stamp every
 * outgoing message with a monotonically increasing sequence number, with
 * optional persistence so the counter survives client reconnections.
 *
 * @example
 * ```ts
 * import { server } from '@wskit/server';
 *
 * const s = withSequence(server('app'));
 * ```
 */
export function withSequence<TState extends ScopeStateShape, TFeatures>(
  builder: ServerBuilderFull<TState, TFeatures>,
): ServerBuilderFull<TState, TFeatures & { sequence: true }> {
  applyFeature(builder, KINDS, (t) => {
    t.sequence = function (this: BuilderInternals, options?: SequenceOptions) {
      this._primitives.push(createSequence(options) as unknown as Primitive);
      return this;
    };
  });
  return builder as ServerBuilderFull<TState, TFeatures & { sequence: true }>;
}
