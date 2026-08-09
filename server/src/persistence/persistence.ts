import type { Primitive } from '~/primitive.ts';

/** The TypeScript type returned by `persistence()`. */
export interface PersistencePrimitive extends Primitive<'persistence'> {}

/** @internal */
const PERSISTENCE_KEY = Symbol('persistence');

/**
 * Activates per-user durable state. Once listed, the engine starts writing
 * channel memberships and persistent tags across reconnects — the owning
 * capabilities (`channels()`, `tags()`) create and manage their own tables
 * regardless of whether this is listed. Channels persist by default; set
 * `persistent: false` in a channel's definition config to opt out per channel.
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
    __requires: {},
    __setup(engine) {
      engine.setPersistenceEnabled(true);
    },
  };
}

/** Symbol identity for the `persistence` primitive. */
persistence.__key = PERSISTENCE_KEY;
