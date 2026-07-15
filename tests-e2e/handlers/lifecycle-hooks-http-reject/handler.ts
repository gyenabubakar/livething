import { define, t } from '@wskit/server';
import { RejectUpgrade } from '@wskit/server/errors';
import type { InferClient } from '@wskit/server';

const base = define({
  env: t<Env>(),
  upgrade: () => {
    throw RejectUpgrade(403, 'Forbidden HTTP upgrade');
  },
  capabilities: [],
});

export const rejectHttpHandler = base.assemble({ handlers: [] });

export type LifecycleHooksHttpRejectClient = InferClient<typeof rejectHttpHandler>;
