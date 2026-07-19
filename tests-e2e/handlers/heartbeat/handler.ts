import { define, emits, t } from '@wskit/server';
import { plugin } from '@wskit/server/plugin';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

/**
 * A plugin that observes the same ping/pong frames the app does. It proves a
 * plugin's `onPing` / `onPong` fire over the wire — a plugin used to be rejected
 * for listing them. Its markers ride under the plugin's own namespace.
 */
const probe = define({
  scoped: true,
  capabilities: [
    emits({
      'plugin-ping-seen': t<{ connectionId: string }>(),
      'plugin-pong-seen': t<{ connectionId: string }>(),
    }),
  ],
});

probe.onPing((ctx) => {
  ctx.send('plugin-ping-seen', { connectionId: ctx.connection.id });
});

probe.onPong((ctx) => {
  ctx.send('plugin-pong-seen', { connectionId: ctx.connection.id });
});

const HeartbeatProbe = plugin('e2e:heartbeat', { handler: probe.assemble({ handlers: [] }) });

/**
 * A server with no `keepalive()`. It proves the heartbeat hooks are free: the
 * engine answers a client ping on its own, and `base.onPing` / `base.onPong`
 * still fire with no capability listed. It never sends a ping of its own. The
 * listed plugin observes the same frames.
 */
const base = define({
  env: t<Env>(),
  upgrade: (request) => requireUsername(request),
  capabilities: [
    HeartbeatProbe(),
    emits({
      'ping-seen': t<{ connectionId: string }>(),
      'pong-seen': t<{ connectionId: string }>(),
    }),
  ],
});

base.onPing((ctx) => {
  ctx.send('ping-seen', { connectionId: ctx.connection.id });
});

base.onPong((ctx) => {
  ctx.send('pong-seen', { connectionId: ctx.connection.id });
});

export const heartbeatHandler = base.assemble({ handlers: [] });

export type HeartbeatClient = InferClient<typeof heartbeatHandler>;
