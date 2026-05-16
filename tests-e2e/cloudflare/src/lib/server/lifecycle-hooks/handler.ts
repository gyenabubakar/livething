import { event, server } from '@wskit/server';
import { withErrors } from '@wskit/server/errors';
import { withLifecycle } from '@wskit/server/lifecycle';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const Connected = event('connected', v.object({ username: v.string() }));
const Disconnected = event('disconnected', v.object({ username: v.string() }));
// Broadcast the WebSocket close code and reason observed by
// onDisconnect. Pins F3: the engine threads the close metadata from
// the adapter into the disconnect ctx so user code can branch on it.
const DisconnectClose = event(
  'disconnect-close',
  v.object({ username: v.string(), code: v.number(), reason: v.string() }),
);
const ValidationErrorFired = event('validation-error-fired', v.object({ event: v.string() }));
const ErrorFired = event('error-fired', v.object({ message: v.string() }));
const BadEvent = event('bad-event', v.object({ value: v.number() }));
const TriggerError = event('trigger-error', v.object({}));
const UpgradeMeta = event('upgrade-meta', v.object({ username: v.string() }));
const ConnectCount = event('connect-count', v.object({ count: v.number() }));
const AsyncHookComplete = event('async-hook-complete', v.object({ complete: v.boolean() }));

export const lifecycleHooksHandler = withErrors(withLifecycle(server<Env>('lifecycle-hooks')))
  .outgoing(Connected)
  .outgoing(Disconnected)
  .outgoing(DisconnectClose)
  .outgoing(ValidationErrorFired)
  .outgoing(ErrorFired)
  .outgoing(UpgradeMeta)
  .outgoing(ConnectCount)
  .outgoing(AsyncHookComplete)
  .onUpgrade((request) => requireUsername(request))
  .onConnect((ctx) => {
    ctx.send('connected', { username: ctx.meta.username as string });
    ctx.send('upgrade-meta', { username: ctx.meta.username as string });
    ctx.send('connect-count', { count: 2 });
    ctx.send('async-hook-complete', { complete: true });
  })
  .onDisconnect((ctx) => {
    ctx.broadcast('disconnected', { username: ctx.meta.username as string });
    // Fan out the close metadata too. Peers receive the leaver's
    // closeCode + closeReason so the e2e can assert each kind of
    // close (graceful 1000, kick 4xxx) lands with the right values.
    ctx.broadcast('disconnect-close', {
      username: ctx.meta.username as string,
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
  .incoming(BadEvent, (_ctx, payload) => {
    void payload.value;
  })
  .incoming(TriggerError, () => {
    throw new Error('test-error');
  })
  .build();
