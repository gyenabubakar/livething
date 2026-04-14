import { applyFeature } from '~/_types/feature-methods.ts';
import { ReplayBuilder } from '~/replay/builder.ts';
import type { BuilderInternals, ServerBuilderFull } from '~/_types/feature-methods.ts';
import type { ScopeStateShape } from '~/_types/scope-state.ts';
import type { ReplayType } from '~/replay/types.ts';

function replayImpl(
  parent: BuilderInternals,
  typeOrCallback?: ReplayType | ((...args: unknown[]) => unknown),
  callback?: (...args: unknown[]) => unknown,
) {
  const type = typeof typeOrCallback === 'function' ? undefined : typeOrCallback;
  const cb = typeof typeOrCallback === 'function' ? typeOrCallback : callback;
  const builder = new ReplayBuilder(parent, parent._primitives, type);
  if (cb) {
    cb(builder);
    builder._seal();
    return parent;
  }
  return builder;
}

const KINDS = ['server', 'group'] as const;

export function withReplay<TState extends ScopeStateShape, TFeatures>(
  builder: ServerBuilderFull<TState, TFeatures>,
): ServerBuilderFull<TState, TFeatures & { replay: true }> {
  applyFeature(builder, KINDS, (t) => {
    t.replay = function (
      this: BuilderInternals,
      typeOrCallback?: ReplayType | ((...args: unknown[]) => unknown),
      callback?: (...args: unknown[]) => unknown,
    ) {
      return replayImpl(this, typeOrCallback, callback);
    };
  });
  return builder as ServerBuilderFull<TState, TFeatures & { replay: true }>;
}
