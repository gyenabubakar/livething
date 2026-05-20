import { contract, implement, request, t } from '@wskit/server';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

export const errorHookIsolationContract = contract<Env>('error-hook-isolation')({
  meta: t<{ username: string }>(),
  definitions: [
    request('do-request', {
      payload: v.object({ text: v.string() }),
      response: v.object({ text: v.string() }),
    }),
  ],
});

export const errorHookIsolationHandler = implement(errorHookIsolationContract)
  .onUpgrade((request) => requireUsername(request))
  .onError(() => {
    // Hook intentionally throws — the engine must still send `_error` to the
    // client so the request Promise rejects instead of hanging.
    throw new Error('observability sink is down');
  })
  .request('do-request', async (_ctx) => {
    // Throw an unrecognized error from the request handler. The engine should
    // normalize it into `internal-error` and still send `_error` despite the
    // onError hook above blowing up.
    throw new Error('handler boom');
  })
  .build();

export type ErrorHookIsolationClient = InferClient<typeof errorHookIsolationHandler>;
