import { define, emits, t } from '@wskit/server';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

/**
 * A server with no `keepalive()`. It proves the heartbeat hooks are free: the
 * engine answers a client ping on its own, and `base.onPing` / `base.onPong`
 * still fire with no capability listed. It never sends a ping of its own.
 */
const base = define({
  env: t<Env>(),
  upgrade: (request) => requireUsername(request),
  capabilities: [
    emits({
      'ping-seen': t<{ connectionId: string }>(),
      'pong-seen': t<{ connectionId: string }>(),
    }),
  ],
});

base.onPing((ctx) => {
  ctx.send('ping-seen', { connectionId: ctx.id });
});

base.onPong((ctx) => {
  ctx.send('pong-seen', { connectionId: ctx.id });
});

export const heartbeatHandler = base.assemble();

export type HeartbeatClient = InferClient<typeof heartbeatHandler>;
