import { applyFeature } from '~/_builder/apply-feature.ts';
import { ReplayCustomBuilder } from '~/replay/custom/builder.ts';
import type { BuilderInternals, ServerBuilderFull } from '~/_types/feature-methods.ts';
import type { ScopeStateShape } from '~/_types/scope-state';

function replayCustomImpl(parent: BuilderInternals, callback?: (...args: unknown[]) => unknown) {
  const builder = new ReplayCustomBuilder(parent, parent._primitives);
  if (callback) {
    callback(builder);
    builder._seal();
    return parent;
  }
  return builder;
}

const KINDS = ['server', 'channel'] as const;

/**
 * Add custom replay logic to a server builder.
 *
 * Once enabled, you can call `.replayCustom()` on the builder to define your
 * own replay pipeline using `onBeforeSend`, `onAfterSend`, and `onReplay`
 * hooks, giving you full control over what gets stored and what gets replayed
 * to reconnecting clients.
 *
 * Cascade behavior matches `withReplay`: a server-level `.replayCustom(...)`
 * captures every outgoing message, including channel-scoped traffic. Channels
 * that register their own `.replay(...)` or `.replayCustom(...)` claim their
 * scope and the server-level cascade skips them. A channel can opt out via
 * `.replay(false)` inside it.
 *
 * @example
 * ```ts
 * import { server } from '@wskit/server';
 *
 * const s = withReplayCustom(server('app'));
 * ```
 */
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
