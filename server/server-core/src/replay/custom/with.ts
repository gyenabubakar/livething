import { applyFeature } from '~/_builder/apply-feature.ts';
import { ReplayCustomBuilder } from '~/replay/custom/builder.ts';
import type { BuilderInternals, ServerBuilderFull } from '~/_types/feature-methods.ts';
import type { ScopeStateShape } from '~/_types/scope-state.ts';

function replayCustomImpl(parent: BuilderInternals, callback?: (...args: unknown[]) => unknown) {
  const builder = new ReplayCustomBuilder(parent, parent._primitives);
  if (callback) {
    callback(builder);
    builder._seal();
    return parent;
  }
  return builder;
}

const KINDS = ['server', 'group'] as const;

export function withReplayCustom<TState extends ScopeStateShape, TFeatures>(
  builder: ServerBuilderFull<TState, TFeatures>,
): ServerBuilderFull<TState, TFeatures & { replayCustom: true }> {
  applyFeature(builder, KINDS, (t) => {
    t.replayCustom = function (this: BuilderInternals, callback?: (...args: unknown[]) => unknown) {
      return replayCustomImpl(this, callback);
    };
  });
  return builder as ServerBuilderFull<TState, TFeatures & { replayCustom: true }>;
}
