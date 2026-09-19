import { server } from '@livething/server';
import { keepalive } from '@livething/server/keepalive';
import type { InferClient } from '@livething/server';
import { requireUsername } from '../_shared/upgrade.ts';

const base = server({
  upgrade: (request) => requireUsername(request),
  capabilities: [
    // Ping every 1s, close after 2s of silence. The ping lands with a ~1s margin
    // before the idle window elapses, so a live client's pong always keeps it
    // open — enough headroom to keep the liveness tests off the flaky edge.
    keepalive({ pingIntervalMs: 1_000, idleTimeoutMs: 2_000 }),
  ],
});

export const keepaliveDefinition = base.assemble({ handlers: [] });

export type KeepaliveClient = InferClient<typeof keepaliveDefinition>;
