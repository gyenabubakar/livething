import { emits, server, t } from '@livething/server';
import { ValidationFailed } from '@livething/server/errors';
import * as v from 'valibot';
import type { InferClient } from '@livething/server';
import { requireUsername } from '../_shared/authenticate.ts';

const base = server({
  authenticate: (request) => requireUsername(request),
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
      'auth-meta': t<{ username: string }>(),
      'connect-count': t<{ count: number }>(),
      'async-hook-complete': t<{ complete: boolean }>(),
    }),
  ],
  onConnect(ctx) {
    ctx.send('connected', { username: ctx.meta.username });
    ctx.send('auth-meta', { username: ctx.meta.username });
    ctx.send('connect-count', { count: 2 });
    ctx.send('async-hook-complete', { complete: true });
  },
  onDisconnect(ctx) {
    ctx.broadcast('disconnected', { username: ctx.meta.username });
    // Fan out the close metadata too. Peers receive the leaver's
    // closeCode + closeReason so the e2e can assert each kind of
    // close (graceful 1000, kick 4xxx) lands with the right values.
    ctx.broadcast('disconnect-close', {
      username: ctx.meta.username,
      code: ctx.closeCode ?? -1,
      reason: ctx.closeReason ?? '',
    });
  },
  onShutdown(ctx) {
    ctx.broadcast('disconnected', { username: 'server-shutdown' });
  },
  onError(ctx, err, eventName) {
    if (ValidationFailed.matches(err)) {
      ctx.send('validation-error-fired', { event: eventName ?? 'unknown' });
    }

    ctx.send('error-fired', { message: err instanceof Error ? err.message : String(err) });
  },
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

export const lifecycleHooksDefinition = base.assemble({
  handlers: [handleBadEvent, handleTriggerError],
});

export type LifecycleHooksClient = InferClient<typeof lifecycleHooksDefinition>;
