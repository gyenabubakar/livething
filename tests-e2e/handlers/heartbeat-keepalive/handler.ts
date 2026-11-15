import { emits, server, t } from '@livething/server';
import { keepalive } from '@livething/server/keepalive';
import type { InferClient } from '@livething/server';
import { requireUsername } from '../_shared/authenticate.ts';

/**
 * A server that lists `keepalive()`. It pings fast so a pong round-trip lands
 * inside the test window, and reports what `ctx.latency` holds by the time the
 * app's own `onPong` runs — which is only non-null if keepalive measured the
 * round-trip first.
 */
const base = server({
  authenticate: (request) => requireUsername(request),
  capabilities: [
    keepalive({ pingIntervalMs: 1_000, idleTimeoutMs: 10_000 }),
    emits({
      'pong-seen': t<{ latency: number | null; quality: string | null }>(),
    }),
  ],
  onPong(ctx) {
    ctx.send('pong-seen', { latency: ctx.latency, quality: ctx.quality });
  },
});

export const heartbeatKeepaliveDefinition = base.assemble({ handlers: [] });

export type HeartbeatKeepaliveClient = InferClient<typeof heartbeatKeepaliveDefinition>;
