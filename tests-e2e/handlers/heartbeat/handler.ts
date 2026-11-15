import { emits, server, t } from '@livething/server';
import { plugin } from '@livething/server/plugins';
import type { InferClient } from '@livething/server';
import { requireUsername } from '../_shared/authenticate.ts';

/**
 * A plugin that observes the same ping/pong frames the app does. It proves a
 * plugin's `onPing` / `onPong` fire over the wire. Its markers ride under the
 * plugin's own namespace.
 */
const probe = server({
  scope: 'plugin',
  capabilities: [
    emits({
      'plugin-ping-seen': t<{ connectionId: string }>(),
      'plugin-pong-seen': t<{ connectionId: string }>(),
    }),
  ],
  onPing(ctx) {
    ctx.send('plugin-ping-seen', { connectionId: ctx.connection.id });
  },
  onPong(ctx) {
    ctx.send('plugin-pong-seen', { connectionId: ctx.connection.id });
  },
});

const HeartbeatProbe = plugin('e2e:heartbeat', { definition: probe.assemble({ handlers: [] }) });

/**
 * A server with no `keepalive()`. It proves the heartbeat hooks are free: the
 * engine answers a client ping on its own, and `onPing` / `onPong`
 * still fire with no capability listed. It never sends a ping of its own. The
 * listed plugin observes the same frames.
 */
const base = server({
  authenticate: (request) => requireUsername(request),
  capabilities: [
    HeartbeatProbe(),
    emits({
      'ping-seen': t<{ connectionId: string }>(),
      'pong-seen': t<{ connectionId: string }>(),
    }),
  ],
  onPing(ctx) {
    ctx.send('ping-seen', { connectionId: ctx.connection.id });
  },
  onPong(ctx) {
    ctx.send('pong-seen', { connectionId: ctx.connection.id });
  },
});

export const heartbeatDefinition = base.assemble({ handlers: [] });

export type HeartbeatClient = InferClient<typeof heartbeatDefinition>;
