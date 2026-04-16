import { applyFeature } from '~/_builder/apply-feature.ts';
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

const KINDS = ['server', 'group', 'channel'] as const;

/**
 * Add built-in message replay support to a server builder.
 *
 * Once enabled, you can call `.replay()` on the builder to configure replay
 * behaviour. When a client reconnects, it can request all messages it missed
 * since a given sequence number and the server will re-deliver them
 * automatically.
 *
 * @example
 * ```ts
 * import { server } from '@wskit/server';
 *
 * const s = withReplay(server('app'));
 * ```
 */
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
