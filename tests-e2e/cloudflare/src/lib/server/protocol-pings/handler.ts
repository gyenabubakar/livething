import { contract, implement, t } from '@wskit/server';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

export const protocolPingsContract = contract('protocol-pings', {
  env: t<Env>(),
  meta: t<{ username: string }>(),
  definitions: [],
});

export const protocolPingsHandler = implement(protocolPingsContract)
  .onUpgrade((request) => requireUsername(request))
  .build();

export type ProtocolPingsClient = InferClient<typeof protocolPingsHandler>;
