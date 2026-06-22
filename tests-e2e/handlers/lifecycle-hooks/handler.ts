import { define, emits, t } from '@wskit/server';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

const base = define({
  env: t<Env>(),
  upgrade: (request) => requireUsername(request),
  capabilities: [
    emits({
      connected: t<{ username: string }>(),
      disconnected: t<{ username: string }>(),
      // Broadcast the WebSocket close code and reason observed by
      // disconnect. Pins F3: the engine threads the close metadata from
      // the adapter into the disconnect ctx so user code can branch on it.
      'disconnect-close': t<{
        username: string;
        code: number;
        reason: string;
      }>(),
      'validation-error-fired': t<{ event: string }>(),
      'error-fired': t<{ message: string }>(),
      'upgrade-meta': t<{ username: string }>(),
      'connect-count': t<{ count: number }>(),
      'async-hook-complete': t<{ complete: boolean }>(),
    }),
  ],
});

base.connect((ctx) => {
  ctx.send('connected', { username: ctx.meta.username });
  ctx.send('upgrade-meta', { username: ctx.meta.username });
  ctx.send('connect-count', { count: 2 });
  ctx.send('async-hook-complete', { complete: true });
});

base.disconnect((ctx) => {
  ctx.broadcast('disconnected', { username: ctx.meta.username });
  // Fan out the close metadata too. Peers receive the leaver's
  // closeCode + closeReason so the e2e can assert each kind of
  // close (graceful 1000, kick 4xxx) lands with the right values.
  ctx.broadcast('disconnect-close', {
    username: ctx.meta.username,
    code: ctx.closeCode ?? -1,
    reason: ctx.closeReason ?? '',
  });
});

base.shutdown((ctx) => {
  ctx.broadcast('disconnected', { username: 'server-shutdown' });
});

base.error((ctx, err) => {
  ctx.send('error-fired', { message: err instanceof Error ? err.message : String(err) });
});

base.validationError((ctx, eventName) => {
  ctx.send('validation-error-fired', { event: eventName });
});

const handleBadEvent = base.on('bad-event', {
  input: v.object({ value: v.number() }),
  run(_ctx, input) {
    void input.value;
  },
});

const handleTriggerError = base.on('trigger-error', {
  input: v.object({}),
  run() {
    throw new Error('test-error');
  },
});

export const lifecycleHooksHandler = base.assemble(handleBadEvent, handleTriggerError);

export type LifecycleHooksClient = InferClient<typeof lifecycleHooksHandler>;
