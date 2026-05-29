import { contract, implement, t } from '@wskit/server';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

export const heartbeatContract = contract('heartbeat', {
  env: t<Env>(),
  // 2s close window. The keepalive ping fires at timeout/2 (1s), so a live
  // client's pong always lands with a ~1s margin before the window elapses —
  // enough headroom to keep the liveness tests off the flaky edge.
  heartbeat: { timeoutMs: 2_000 },
  meta: t<{ username: string }>(),
  definitions: [],
});

export const heartbeatHandler = implement(heartbeatContract)
  .onUpgrade((request) => requireUsername(request))
  .build();

export type HeartbeatClient = InferClient<typeof heartbeatHandler>;
