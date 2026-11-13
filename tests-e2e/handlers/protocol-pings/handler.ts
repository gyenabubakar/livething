import { server } from '@livething/server';
import type { InferClient } from '@livething/server';
import { requireUsername } from '../_shared/authenticate.ts';

const base = server({
  authenticate: (request) => requireUsername(request),
  capabilities: [],
});

export const protocolPingsDefinition = base.assemble({ handlers: [] });

export type ProtocolPingsClient = InferClient<typeof protocolPingsDefinition>;
