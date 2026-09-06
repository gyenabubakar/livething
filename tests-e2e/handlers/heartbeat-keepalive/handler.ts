import { define, emits, t } from '@wskit/server';
import { keepalive } from '@wskit/server/keepalive';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

/**
 * A server that lists `keepalive()`. It pings fast so a pong round-trip lands
 * inside the test window, and reports what `ctx.latency` holds by the time the
 * app's own `onPong` runs — which is only non-null if keepalive measured the
 * round-trip first.
 */
const base = define({
  upgrade: (request) => requireUsername(request),
  capabilities: [
    keepalive({ pingIntervalMs: 1_000, idleTimeoutMs: 10_000 }),
    emits({
      'pong-seen': t<{ latency: number | null; quality: string | null }>(),
    }),
  ],
});

base.onPong((ctx) => {
  ctx.send('pong-seen', { latency: ctx.latency, quality: ctx.quality });
});

export const heartbeatKeepaliveHandler = base.assemble({ handlers: [] });

export type HeartbeatKeepaliveClient = InferClient<typeof heartbeatKeepaliveHandler>;
