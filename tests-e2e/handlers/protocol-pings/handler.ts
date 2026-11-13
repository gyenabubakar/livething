import { server } from '@livething/server';
import { keepalive } from '@livething/server/keepalive';
import type { InferClient } from '@livething/server';
import { requireUsername } from '../_shared/authenticate.ts';

const base = server({
  authenticate: (request) => requireUsername(request),
  capabilities: [keepalive()],
});

export const protocolPingsDefinition = base.assemble({ handlers: [] });

export type ProtocolPingsClient = InferClient<typeof protocolPingsDefinition>;
