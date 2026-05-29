import { contract, implement, t } from '@wskit/server';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

export const keepaliveContract = contract('keepalive', {
  env: t<Env>(),
  // Ping every 1s, close after 2s of silence. The ping lands with a ~1s margin
  // before the idle window elapses, so a live client's pong always keeps it
  // open — enough headroom to keep the liveness tests off the flaky edge.
  keepalive: { pingIntervalMs: 1_000, idleTimeoutMs: 2_000 },
  meta: t<{ username: string }>(),
  definitions: [],
});

export const keepaliveHandler = implement(keepaliveContract)
  .onUpgrade((request) => requireUsername(request))
  .build();

export type KeepaliveClient = InferClient<typeof keepaliveHandler>;
