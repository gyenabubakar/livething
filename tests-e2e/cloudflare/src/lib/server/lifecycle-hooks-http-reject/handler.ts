import { contract, implement, t } from '@wskit/server';
import { RejectUpgrade } from '@wskit/server/errors';
import type { InferClient } from '@wskit/server';

export const rejectHttpContract = contract('reject-http-test', { env: t<Env>(), definitions: [] });

export const rejectHttpHandler = implement(rejectHttpContract)
  .onUpgrade(() => {
    throw RejectUpgrade(403, 'Forbidden HTTP upgrade');
  })
  .build();

export type LifecycleHooksHttpRejectClient = InferClient<typeof rejectHttpHandler>;
