import { server } from '@livething/server';
import type { InferClient } from '@livething/server';
import { requireUsername } from '../_shared/upgrade.ts';

const base = server({
  upgrade: (request) => requireUsername(request),
  capabilities: [],
});

export const protocolPingsDefinition = base.assemble({ handlers: [] });

export type ProtocolPingsClient = InferClient<typeof protocolPingsDefinition>;
