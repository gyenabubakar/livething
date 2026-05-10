import { event, scope, server } from '@wskit/server';
import { withChannels } from '@wskit/server/channels';
import { ValidationFailed } from '@wskit/server/errors';
import { withLifecycle } from '@wskit/server/lifecycle';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const RoomMessage = event(
  'room-message',
  v.object({
    channel: v.string(),
    text: v.string(),
    from: v.string(),
    kind: v.string(),
  }),
);
const SendMessage = event('send-message', v.object({ text: v.string() }));
const EchoName = event('echo-name', v.object({}));
const NameResult = event('name-result', v.object({ name: v.string(), suffix: v.string() }));

// Top-level event with a handler. Used to verify scope isolation: a client
// inside the `room` channel scope sending this event with `_channel: 'room:1'`
// must NOT reach the top-level handler. Pre-fix the dispatcher fell through
// to top-level handlers when the scoped lookup missed.
const TopOnlyAction = event('top-only-action', v.object({}));
const TopOnlyActionFired = event('top-only-action-fired', v.object({ from: v.string() }));

// Channel-scoped handler that performs a custom semantic check and manually
// throws ValidationFailed. Used to pin that onValidationError sees ctx.channel
// for manually-thrown failures (not just schema-failed payloads).
const TriggerManualValidation = event('trigger-manual-validation', v.object({}));
const ValidationObserved = event(
  'validation-observed',
  v.object({ channel: v.string(), event: v.string() }),
);

// Channel-scoped handler that throws an unrecognized error. Used to pin that
// onError sees ctx.channel for runtime errors that bubble out of a scoped
// handler — not just a top-level ctx.
const TriggerScopedError = event('trigger-scoped-error', v.object({}));
const ScopedErrorObserved = event(
  'scoped-error-observed',
  v.object({ channel: v.string(), scope: v.string(), event: v.string() }),
);

const base = withChannels(withLifecycle(server<Env>('channel-dynamic')))
  .onUpgrade((request) => requireUsername(request))
  .outgoing(TopOnlyActionFired)
  .outgoing(ValidationObserved)
  .outgoing(ScopedErrorObserved)
  .incoming(TopOnlyAction, (ctx) => {
    ctx.send('top-only-action-fired', { from: ctx.meta.username });
  })
  .onError((ctx, _error, eventName) => {
    const c = ctx as unknown as { channel?: { name?: string; scope?: string | null } };
    ctx.send('scoped-error-observed', {
      channel: c.channel?.name ?? '<top-level>',
      scope: c.channel?.scope ?? '<no-scope>',
      event: eventName ?? '<unknown>',
    });
  })
  .onValidationError((ctx, eventName) => {
    // The hook reports the scope it observed back to the connection.
    // For a manually-thrown ValidationFailed inside the room channel,
    // ctx.channel must be set; pre-fix it was undefined.
    const c = ctx as unknown as { channel?: { name?: string } };
    ctx.send('validation-observed', {
      channel: c.channel?.name ?? '<top-level>',
      event: eventName,
    });
  });

const roomChannel = base.channel(scope('room', /^room:.+$/), (ch) =>
  ch
    .outgoing(RoomMessage)
    .outgoing(NameResult)
    .incoming(SendMessage, (ctx, payload) => {
      ctx.channel.broadcast('room-message', {
        channel: ctx.channel.name,
        text: payload.text,
        from: ctx.meta.username,
        kind: 'user',
      });
    })
    .incoming(EchoName, (ctx) => {
      const name = ctx.channel.name;
      const suffix = name.slice(name.indexOf(':') + 1);
      ctx.channel.send('name-result', { name, suffix });
    })
    .incoming(TriggerManualValidation, () => {
      throw ValidationFailed({
        event: 'trigger-manual-validation',
        issues: [{ message: 'manual semantic check failed' }],
      });
    })
    .incoming(TriggerScopedError, () => {
      throw new Error('scoped runtime error');
    })
    .onBeforeSubscribe(async (ctx) => {
      if (ctx.meta.username === 'banned-user') {
        throw new Error('banned-user may not subscribe');
      }
      if (ctx.meta.username === 'async-banned-user') {
        await new Promise((r) => setTimeout(r, 20));
        throw new Error('async-banned-user may not subscribe');
      }
      // Slow but successful gate. Used by the concurrent-subscribe race
      // test: two clients reach this hook at the same time, both await,
      // then both commit. Pre-fix each snapshotted the empty member list
      // before the await and missed the other in its initial sync.
      if (ctx.meta.username.startsWith('slow-user')) {
        await new Promise((r) => setTimeout(r, 50));
      }
    })
    .onSubscribe((ctx) => {
      ctx.channel.broadcast('room-message', {
        channel: ctx.channel.name,
        text: `${ctx.meta.username} entered`,
        from: 'system',
        kind: 'system',
      });
    })
    .onUnsubscribe((ctx) => {
      ctx.channel.broadcast('room-message', {
        channel: ctx.channel.name,
        text: `${ctx.meta.username} left`,
        from: 'system',
        kind: 'system',
      });
    }),
);

export const channelDynamicHandler = base.use(roomChannel).build();
