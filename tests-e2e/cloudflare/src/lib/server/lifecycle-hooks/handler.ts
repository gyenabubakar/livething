import { contract, implement, incoming, outgoing, t } from '@wskit/server';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

export const lifecycleHooksContract = contract('lifecycle-hooks', {
  env: t<Env>(),
  meta: t<{ username: string }>(),
  definitions: [
    outgoing('connected', v.object({ username: v.string() })),
    outgoing('disconnected', v.object({ username: v.string() })),
    // Broadcast the WebSocket close code and reason observed by
    // onDisconnect. Pins F3: the engine threads the close metadata from
    // the adapter into the disconnect ctx so user code can branch on it.
    outgoing(
      'disconnect-close',
      v.object({ username: v.string(), code: v.number(), reason: v.string() }),
    ),
    outgoing('validation-error-fired', v.object({ event: v.string() })),
    outgoing('error-fired', v.object({ message: v.string() })),
    outgoing('upgrade-meta', v.object({ username: v.string() })),
    outgoing('connect-count', v.object({ count: v.number() })),
    outgoing('async-hook-complete', v.object({ complete: v.boolean() })),

    incoming('bad-event', v.object({ value: v.number() })),
    incoming('trigger-error', v.object({})),
  ],
});

export const lifecycleHooksHandler = implement(lifecycleHooksContract)
  .onUpgrade((request) => requireUsername(request))
  .onConnect((ctx) => {
    ctx.send('connected', { username: ctx.meta.username });
    ctx.send('upgrade-meta', { username: ctx.meta.username });
    ctx.send('connect-count', { count: 2 });
    ctx.send('async-hook-complete', { complete: true });
  })
  .onDisconnect((ctx) => {
    ctx.broadcast('disconnected', { username: ctx.meta.username });
    // Fan out the close metadata too. Peers receive the leaver's
    // closeCode + closeReason so the e2e can assert each kind of
    // close (graceful 1000, kick 4xxx) lands with the right values.
    ctx.broadcast('disconnect-close', {
      username: ctx.meta.username,
      code: ctx.closeCode ?? -1,
      reason: ctx.closeReason ?? '',
    });
  })
  .onShutdown((ctx) => {
    ctx.broadcast('disconnected', { username: 'server-shutdown' });
  })
  .onError((ctx, err) => {
    ctx.send('error-fired', { message: err instanceof Error ? err.message : String(err) });
  })
  .onValidationError((ctx, evt) => {
    ctx.send('validation-error-fired', { event: evt });
  })
  .on('bad-event', (_ctx, payload) => {
    void payload.value;
  })
  .on('trigger-error', () => {
    throw new Error('test-error');
  })
  .build();

export type LifecycleHooksClient = InferClient<typeof lifecycleHooksHandler>;
