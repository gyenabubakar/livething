import { contract, implement } from '@wskit/server';
import { RejectUpgrade } from '@wskit/server/errors';
import type { InferClient } from '@wskit/server';

export const rejectHttpContract = contract<Env>('reject-http-test')({
  definitions: [],
});

export const rejectHttpHandler = implement(rejectHttpContract)
  .onUpgrade(() => {
    throw RejectUpgrade(403, 'Forbidden HTTP upgrade');
  })
  .build();

export type LifecycleHooksHttpRejectClient = InferClient<typeof rejectHttpHandler>;
