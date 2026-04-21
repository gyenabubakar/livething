import { server } from '@wskit/server';
import { withLifecycle } from '@wskit/server/lifecycle';
import { requireUsername } from '../_shared/upgrade.ts';

export const protocolPingsHandler = withLifecycle(server<Env>('protocol-pings'))
  .onUpgrade((request) => requireUsername(request))
  .build();
