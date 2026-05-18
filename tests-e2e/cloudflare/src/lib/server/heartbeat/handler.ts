import { contract, implement, t } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

export const heartbeatContract = contract<Env>('heartbeat')({
  heartbeat: { timeoutMs: 1_000 },
  meta: t<{ username: string }>(),
  definitions: [],
});

export const heartbeatHandler = implement(heartbeatContract)
  .onUpgrade((request) => requireUsername(request))
  .build();
