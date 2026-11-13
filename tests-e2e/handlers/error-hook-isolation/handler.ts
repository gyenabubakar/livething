import { server } from '@livething/server';
import { clientRequests } from '@livething/server/client-requests';
import { keepalive } from '@livething/server/keepalive';
import * as v from 'valibot';
import type { InferClient } from '@livething/server';
import { requireUsername } from '../_shared/authenticate.ts';

const base = server({
  authenticate: (request) => requireUsername(request),
  capabilities: [keepalive(), clientRequests()],
  // Hook intentionally throws — the engine must still send `__error__` to the
  // client so the request Promise rejects instead of hanging.
  onError() {
    throw new Error('observability sink is down');
  },
});

const handleDoRequest = base.request('do-request', {
  input: v.object({ text: v.string() }),
  run(_ctx): { text: string } {
    // Throw an unrecognized error from the request handler. The engine should
    // normalize it into `internal-error` and still send `__error__` despite the
    // onError hook above blowing up.
    throw new Error('handler boom');
  },
});

export const errorHookIsolationDefinition = base.assemble({ handlers: [handleDoRequest] });

export type ErrorHookIsolationClient = InferClient<typeof errorHookIsolationDefinition>;
