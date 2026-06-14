import { define, t } from '@wskit/server';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

const base = define({
  env: t<Env>(),
  upgrade: (request) => requireUsername(request),
  capabilities: [],
});

export const protocolPingsHandler = base.assemble();

export type ProtocolPingsClient = InferClient<typeof protocolPingsHandler>;
