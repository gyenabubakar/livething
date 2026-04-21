import { event, server } from '@wskit/server';
import { withErrors } from '@wskit/server/errors';
import { withLifecycle } from '@wskit/server/lifecycle';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const Connected = event('connected', v.object({ username: v.string() }));
const Disconnected = event('disconnected', v.object({ username: v.string() }));
const ValidationErrorFired = event('validation-error-fired', v.object({ event: v.string() }));
const ErrorFired = event('error-fired', v.object({ message: v.string() }));
const BadEvent = event('bad-event', v.object({ value: v.number() }));

export const lifecycleHooksHandler = withErrors(withLifecycle(server<Env>('lifecycle-hooks')))
  .outgoing(Connected)
  .outgoing(Disconnected)
  .outgoing(ValidationErrorFired)
  .outgoing(ErrorFired)
  .onUpgrade((request) => requireUsername(request))
  .onConnect((ctx) => {
    ctx.send('connected', { username: ctx.meta.username as string });
  })
  .onDisconnect((ctx) => {
    ctx.broadcast('disconnected', { username: ctx.meta.username as string });
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
  .build();
