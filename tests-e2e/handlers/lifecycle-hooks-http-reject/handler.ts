import { server } from '@livething/server';
import { RejectAuth } from '@livething/server/errors';
import type { InferClient } from '@livething/server';

const base = server({
  authenticate: () => {
    throw RejectAuth(403, 'Forbidden HTTP upgrade');
  },
  capabilities: [],
});

export const rejectHttpDefinition = base.assemble({ handlers: [] });

export type LifecycleHooksHttpRejectClient = InferClient<typeof rejectHttpDefinition>;
