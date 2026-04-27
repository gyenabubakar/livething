import { applyFeature } from '~/_builder/apply-feature.ts';
import { ReplayBuilder } from '~/replay/builder.ts';
import { replay as createReplay } from '~/replay/replay.ts';
import type { BuilderInternals, ServerBuilderFull } from '~/_types/feature-methods.ts';
import type { ScopeStateShape } from '~/_types/scope-state';
import type { Primitive } from '~/primitive.ts';
import type { ReplayType } from '~/replay/types.ts';

function replayImpl(
  parent: BuilderInternals,
  typeOrCallback?: ReplayType | false | ((...args: unknown[]) => unknown),
  callback?: (...args: unknown[]) => unknown,
) {
  // `.replay(false)` opts the current scope out of cascade. The disabled
  // primitive carries no hooks; it only marks the scope as claimed so the
  // server-level replay primitive knows to skip messages from this channel.
  if (typeOrCallback === false) {
    parent._primitives.push(createReplay(false) as unknown as Primitive);
    return parent;
  }

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

const KINDS = ['server', 'channel'] as const;

/**
 * Add built-in message replay support to a server builder.
 *
 * Once enabled, you can call `.replay()` on the builder to configure replay
 * behaviour. When a client reconnects, it can request all messages it missed
 * since a given sequence number and the server will re-deliver them
 * automatically.
 *
 * Server-level replay cascades by default — it captures every outgoing
 * message, including channel-scoped traffic. To use a different replay
 * strategy for a specific channel, call `.replay(...)` inside that channel's
 * sub-builder. To opt a specific channel out of replay entirely, call
 * `.replay(false)` inside it; messages on that channel are not stored or
 * replayed by any replay primitive.
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
