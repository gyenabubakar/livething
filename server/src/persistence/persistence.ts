import { reconcilePersistenceOnBoot } from '~/persistence/cleanup.ts';
import { persistenceService } from '~/persistence/service.ts';
import { ensurePersistenceSchema } from '~/persistence/storage.ts';
import type { Primitive } from '~/primitive.ts';

/** The TypeScript type returned by `persistence()`. */
export interface PersistencePrimitive extends Primitive<'persistence'> {}

/** @internal */
const PERSISTENCE_KEY = Symbol('persistence');

/**
 * Activates per-user durable state. At boot the engine creates the
 * user-keyed tables and starts writing channel memberships across
 * reconnects. Channels persist by default; set `persistent: false` in a
 * channel's definition config to opt out per channel.
 *
 * Enable this by listing the `persistence()` capability instead of calling this
 * primitive directly.
 *
 * @example
 * ```ts
 * import { define, t } from '@wskit/server';
 * import { persistence } from '@wskit/server/persistence';
 * import { channels } from '@wskit/server/channels';
 *
 * const base = define({
 *   env: t<Env>(),
 *   capabilities: [persistence(), channels()],
 * });
 * const teamEng = base.channel('team-eng');
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
      engine.setPersistenceService(persistenceService);
      engine.onBootSchema(() => {
        ensurePersistenceSchema(engine.requireStorage().sql);
      });
      engine.onBoot(() => {
        const dropped = reconcilePersistenceOnBoot(engine.requireStorage().sql, (name, scope) =>
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
 * Marker symbol for the `persistence` primitive. Used by plugins that depend
 * on per-user durable state to declare the requirement in their `dependencies`
 * array.
 */
persistence.__key = PERSISTENCE_KEY;
