import { applyFeature } from '~/_builder/apply-feature.ts';
import { persistentMarker as createPersistentMarker } from '~/persistence/channel-marker.ts';
import { persistence as createPersistence } from '~/persistence/persistence.ts';
import type { BuilderInternals, ServerBuilderFull } from '~/_types/feature-methods.ts';
import type { ScopeStateShape } from '~/_types/scope-state';
import type { Primitive } from '~/primitive.ts';

const KINDS = ['server', 'channel'] as const;

/**
 * Add per-user durable state support to a server builder.
 *
 * Once wrapped, you can call `.enablePersistence()` on the builder to turn on
 * identity-keyed channel memberships and persistent tag groups. Channels then
 * survive reconnect — a user re-opens a socket and the engine restores every
 * channel they were in before any handler runs.
 *
 * Wrapping alone has no runtime effect: the type surface gains
 * `.enablePersistence()`, but until you call it the engine still treats every
 * channel as ephemeral (the IRC-style default).
 *
 * @example
 * ```ts
 * import { server } from '@wskit/server';
 * import { withChannels } from '@wskit/server/channels';
 * import { withPersistence } from '@wskit/server/persistence';
 *
 * const handler = withPersistence(withChannels(server('chat')))
 *   .enablePersistence()
 *   .channel('team-eng', (c) => c)
 *   .build();
 * ```
 */
export function withPersistence<TState extends ScopeStateShape, TFeatures>(
  builder: ServerBuilderFull<TState, TFeatures>,
): ServerBuilderFull<TState, TFeatures & { persistence: true }> {
  applyFeature(builder, KINDS, (t) => {
    t.enablePersistence = function (this: BuilderInternals) {
      this._primitives.push(createPersistence() as unknown as Primitive);
      return this;
    };
    t.persistent = function (this: BuilderInternals, enabled: boolean) {
      this._primitives.push(createPersistentMarker(enabled) as unknown as Primitive);
      return this;
    };
  });
  return builder as ServerBuilderFull<TState, TFeatures & { persistence: true }>;
}
