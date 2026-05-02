import { event, server } from '@wskit/server';
import { withErrors } from '@wskit/server/errors';
import { withLifecycle } from '@wskit/server/lifecycle';
import { withRequests } from '@wskit/server/requests';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const DoRequest = event('do-request', v.object({ text: v.string() }));
const ReplySchema = v.object({ text: v.string() });

export const errorHookIsolationHandler = withRequests(
  withErrors(withLifecycle(server<Env>('error-hook-isolation'))),
)
  .onUpgrade((request) => requireUsername(request))
  .onError(() => {
    // Hook intentionally throws — the engine must still send `_error` to the
    // client so the request Promise rejects instead of hanging.
    throw new Error('observability sink is down');
  })
  .request(DoRequest, ReplySchema, async (_ctx) => {
    // Throw an unrecognized error from the request handler. The engine should
    // normalize it into `internal-error` and still send `_error` despite the
    // onError hook above blowing up.
    throw new Error('handler boom');
  })
  .build();
