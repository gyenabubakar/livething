import { define, emits, t } from '@wskit/server';
import { persistence } from '@wskit/server/persistence';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const base = define({
  env: t<Env>(),
  upgrade: requireUsername,
  capabilities: [persistence(), emits({ announced: t<{ text: string }>() })],
});

const noop = base.on('noop', { input: v.object({}), run() {} });

/**
 * A tiny server whose whole point is the admin surface: `persistence()` so
 * `purgeUser` has durable state to wipe, and a top-level `api` whose
 * `announce` method proves a dev-defined admin op runs over the Worker→DO stub.
 */
export const adminHandler = base.assemble({
  handlers: [noop],
  api: (ctx) => ({
    announce(text: string) {
      ctx.broadcast('announced', { text });
    },
  }),
});
