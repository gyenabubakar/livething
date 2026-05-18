import { contract, implement, t } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

export const protocolPingsContract = contract<Env>('protocol-pings')({
  meta: t<{ username: string }>(),
  definitions: [],
});

export const protocolPingsHandler = implement(protocolPingsContract)
  .onUpgrade((request) => requireUsername(request))
  .build();
