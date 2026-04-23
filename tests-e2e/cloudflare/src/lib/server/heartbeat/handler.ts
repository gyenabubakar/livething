import { server } from '@wskit/server';
import { withHeartbeat } from '@wskit/server/heartbeat';
import { withLifecycle } from '@wskit/server/lifecycle';
import { requireUsername } from '../_shared/upgrade.ts';

export const heartbeatHandler = withHeartbeat(withLifecycle(server<Env>('heartbeat')))
  .heartbeat({ timeout: 1_000 })
  .onUpgrade((request) => requireUsername(request))
  .build();
