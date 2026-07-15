import { define, t } from '@wskit/server';
import { requests } from '@wskit/server/requests';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

const base = define({
  env: t<Env>(),
  upgrade: (request) => requireUsername(request),
  capabilities: [requests()],
});

// Hook intentionally throws — the engine must still send `__error__` to the
// client so the request Promise rejects instead of hanging.
base.onError(() => {
  throw new Error('observability sink is down');
});

const handleDoRequest = base.request('do-request', {
  input: v.object({ text: v.string() }),
  run(_ctx): { text: string } {
    // Throw an unrecognized error from the request handler. The engine should
    // normalize it into `internal-error` and still send `__error__` despite the
    // base.onError hook above blowing up.
    throw new Error('handler boom');
  },
});

export const errorHookIsolationHandler = base.assemble({ handlers: [handleDoRequest] });

export type ErrorHookIsolationClient = InferClient<typeof errorHookIsolationHandler>;
