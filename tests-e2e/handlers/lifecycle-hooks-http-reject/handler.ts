import { server } from '@livething/server';
import { RejectUpgrade } from '@livething/server/errors';
import type { InferClient } from '@livething/server';

const base = server({
  upgrade: () => {
    throw RejectUpgrade(403, 'Forbidden HTTP upgrade');
  },
  capabilities: [],
});

export const rejectHttpDefinition = base.assemble({ handlers: [] });

export type LifecycleHooksHttpRejectClient = InferClient<typeof rejectHttpDefinition>;
