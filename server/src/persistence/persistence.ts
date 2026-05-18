import { reconcilePersistenceOnBoot } from '~/persistence/cleanup.ts';
import { ensurePersistenceSchema } from '~/persistence/storage.ts';
import type { Primitive } from '~/primitive.ts';

/** The TypeScript type returned by `persistence()`. */
export interface PersistencePrimitive extends Primitive<'persistence'> {}

/** @internal */
const PERSISTENCE_KEY = Symbol('persistence');

/**
 * Activates per-user durable state. When registered on a server builder, the
 * engine creates the identity-keyed tables at boot and starts writing channel
 * memberships (and, when `withTags` ships persistent groups, persistent tags)
 * across reconnects. Channels persist by default; opt out per-channel with
 * `.persistent(false)` on the channel sub-builder.
 *
 * Most apps will activate this through `.enablePersistence()` on a
 * `withPersistence`-wrapped builder rather than registering this primitive
 * directly.
 *
 * @example
 * ```ts
 * import { server } from '@wskit/server';
 * import { withChannels } from '@wskit/server/channels';
 * import { withPersistence } from '@wskit/server/persistence';
 *
 * withPersistence(withChannels(server('chat')))
 *   .enablePersistence()
 *   .channel('team-eng', (c) => c)
 *   .build();
 * ```
 */
export function persistence(): PersistencePrimitive {
  return {
    __wskit: 'persistence',
    __kind: 'infrastructure',
    __identity: [PERSISTENCE_KEY],
    __requires: { storage: true },
    __setup(engine) {
      engine.setPersistenceEnabled(true);
      engine.onBoot(() => {
        const sql = engine.requireStorage().sql;
        ensurePersistenceSchema(sql);
        const dropped = reconcilePersistenceOnBoot(sql, (name, scope) =>
          engine.isDurableMembershipPairPersistent(name, scope),
        );
        if (dropped > 0) {
          engine
            .getLogger?.()
            ?.info?.(
              `[wskit] persistence boot cleanup dropped ${dropped} orphaned channel-scope row group(s)`,
            );
        }
      });
    },
  };
}

/**
 * Marker symbol for the `persistence` primitive. Used by modules that depend
 * on per-user durable state to declare the requirement in their `dependencies`
 * array.
 */
persistence.__key = PERSISTENCE_KEY;
