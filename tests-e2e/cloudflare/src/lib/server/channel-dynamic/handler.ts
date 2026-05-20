import { channel, contract, implement, incoming, outgoing, scope, t } from '@wskit/server';
import { ValidationFailed } from '@wskit/server/errors';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

const RoomMessagePayload = v.object({
  channel: v.string(),
  text: v.string(),
  from: v.string(),
  kind: v.string(),
});
const SendMessagePayload = v.object({ text: v.string() });
const NameResultPayload = v.object({ name: v.string(), suffix: v.string() });

const TopOnlyActionFiredPayload = v.object({ from: v.string() });
const ValidationObservedPayload = v.object({ channel: v.string(), event: v.string() });
const ScopedErrorObservedPayload = v.object({
  channel: v.string(),
  scope: v.string(),
  event: v.string(),
});
const TriggerServerSubscribeDynamicPayload = v.object({ name: v.string() });

export const channelDynamicContract = contract<Env>('channel-dynamic')({
  meta: t<{ username: string }>(),
  definitions: [
    incoming('top-only-action', v.object({})),
    incoming('trigger-server-subscribe-dynamic', TriggerServerSubscribeDynamicPayload),

    outgoing('top-only-action-fired', TopOnlyActionFiredPayload),
    outgoing('validation-observed', ValidationObservedPayload),
    outgoing('scoped-error-observed', ScopedErrorObservedPayload),

    channel(scope('room', /^room:.+$/), {
      definitions: [
        incoming('send-message', SendMessagePayload),
        incoming('echo-name', v.object({})),
        incoming('trigger-manual-validation', v.object({})),
        incoming('trigger-scoped-error', v.object({})),
        outgoing('room-message', RoomMessagePayload),
        outgoing('name-result', NameResultPayload),
      ],
    }),

    channel(scope('proto-probe', /^proto:.+$/), {
      definitions: [],
    }),
  ],
});

export const channelDynamicHandler = implement(channelDynamicContract)
  .onUpgrade((request) => requireUsername(request))
  .onError((ctx, _error, eventName) => {
    const c = ctx as unknown as { channel?: { name?: string; scope?: string | null } };
    ctx.send('scoped-error-observed', {
      channel: c.channel?.name ?? '<top-level>',
      scope: c.channel?.scope ?? '<no-scope>',
      event: eventName ?? '<unknown>',
    });
  })
  .onValidationError((ctx, eventName) => {
    const c = ctx as unknown as { channel?: { name?: string } };
    ctx.send('validation-observed', {
      channel: c.channel?.name ?? '<top-level>',
      event: eventName,
    });
  })

  .on('top-only-action', (ctx) => {
    ctx.send('top-only-action-fired', { from: ctx.meta.username });
  })
  .on('trigger-server-subscribe-dynamic', async (ctx, payload) => {
    await ctx.channels.get('room', payload.name).subscribe(ctx.self);
  })

  .channel('room', (ch) =>
    ch
      .onBeforeSubscribe(async (ctx) => {
        if (ctx.meta.username === 'banned-user') {
          throw new Error('banned-user may not subscribe');
        }
        if (ctx.meta.username === 'async-banned-user') {
          await new Promise((r) => setTimeout(r, 20));
          throw new Error('async-banned-user may not subscribe');
        }
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
      })
      .on('send-message', (ctx, payload) => {
        ctx.channel.broadcast('room-message', {
          channel: ctx.channel.name,
          text: payload.text,
          from: ctx.meta.username,
          kind: 'user',
        });
      })
      .on('echo-name', (ctx) => {
        const name = ctx.channel.name;
        const suffix = name.slice(name.indexOf(':') + 1);
        ctx.channel.send('name-result', { name, suffix });
      })
      .on('trigger-manual-validation', () => {
        throw ValidationFailed({
          event: 'trigger-manual-validation',
          issues: [{ message: 'manual semantic check failed' }],
        });
      })
      .on('trigger-scoped-error', () => {
        throw new Error('scoped runtime error');
      }),
  )

  .channel('proto-probe', (ch) =>
    ch.onBeforeSubscribe((_ctx, data) => {
      const d = data as { role?: unknown } | undefined;
      if (d?.role === 'admin') {
        throw new Error('admin role on subscribe payload is forbidden');
      }
    }),
  )

  .build();

export type ChannelDynamicClient = InferClient<typeof channelDynamicHandler>;
