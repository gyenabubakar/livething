import { server } from '@wskit/server';
import { RejectUpgrade } from '@wskit/server/errors';
import type { InferClient } from '@wskit/server';

const base = server({
  upgrade: () => {
    throw RejectUpgrade(403, 'Forbidden HTTP upgrade');
  },
  capabilities: [],
});

export const rejectHttpDefinition = base.assemble({ handlers: [] });

export type LifecycleHooksHttpRejectClient = InferClient<typeof rejectHttpDefinition>;
