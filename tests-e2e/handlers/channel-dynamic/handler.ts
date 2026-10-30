import { emits, server, t } from '@livething/server';
import { channels } from '@livething/server/channels';
import { ValidationFailed } from '@livething/server/errors';
import * as v from 'valibot';
import type { InferClient } from '@livething/server';
import { requireUsername } from '../_shared/upgrade.ts';

const SendMessagePayload = v.object({ text: v.string() });

const TriggerServerSubscribeDynamicPayload = v.object({ name: v.string() });

const base = server({
  upgrade: (request) => requireUsername(request),
  capabilities: [
    channels(),
    emits({
      'top-only-action-fired': t<{ from: string }>(),
      'validation-observed': t<{ channel: string; event: string }>(),
      'scoped-error-observed': t<{ channel: string; family: string; event: string }>(),
    }),
  ],
  onError(ctx, error, eventName) {
    const c = ctx as unknown as { channel?: { name?: string; family?: string | null } };
    if (ValidationFailed.matches(error)) {
      ctx.send('validation-observed', {
        channel: c.channel?.name ?? '<top-level>',
        event: eventName ?? '<unknown>',
      });
    }

    ctx.send('scoped-error-observed', {
      channel: c.channel?.name ?? '<top-level>',
      family: c.channel?.family ?? '<no-family>',
      event: eventName ?? '<unknown>',
    });
  },
});

const handleTopOnlyAction = base.on('top-only-action', {
  input: v.object({}),
  run(ctx) {
    ctx.send('top-only-action-fired', { from: ctx.meta.username });
  },
});

const handleTriggerServerSubscribeDynamic = base.on('trigger-server-subscribe-dynamic', {
  input: TriggerServerSubscribeDynamicPayload,
  async run(ctx, payload) {
    await ctx.channels.get('room', payload.name).subscribe(ctx.connection);
  },
});

const room = base.channel(['room', 'room:{id}'], {
  // Ephemeral: the leave test drops a connection and expects the
  // onUnsubscribe system broadcast, which needs a true leave on disconnect.
  membership: 'ephemeral',
  capabilities: [
    emits({
      'room-message': t<{ channel: string; text: string; from: string; kind: string }>(),
      'name-result': t<{ name: string; suffix: string }>(),
    }),
  ],
  async check(ctx) {
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
  },
  onSubscribe(ctx) {
    ctx.channel.broadcast('room-message', {
      channel: ctx.channel.name,
      text: `${ctx.meta.username} entered`,
      from: 'system',
      kind: 'system',
    });
  },
  onUnsubscribe(ctx) {
    ctx.channel.broadcast('room-message', {
      channel: ctx.channel.name,
      text: `${ctx.meta.username} left`,
      from: 'system',
      kind: 'system',
    });
  },
});

const handleSendMessage = room.on('send-message', {
  input: SendMessagePayload,
  run(ctx, payload) {
    ctx.channel.broadcast('room-message', {
      channel: ctx.channel.name,
      text: payload.text,
      from: ctx.meta.username,
      kind: 'user',
    });
  },
});

const handleEchoName = room.on('echo-name', {
  input: v.object({}),
  run(ctx) {
    const name = ctx.channel.name;
    const suffix = name.slice(name.indexOf(':') + 1);
    ctx.channel.send('name-result', { name, suffix });
  },
});

const handleTriggerManualValidation = room.on('trigger-manual-validation', {
  input: v.object({}),
  run() {
    throw ValidationFailed({
      event: 'trigger-manual-validation',
      issues: [{ message: 'manual semantic check failed' }],
    });
  },
});

const handleTriggerScopedError = room.on('trigger-scoped-error', {
  input: v.object({}),
  run() {
    throw new Error('scoped runtime error');
  },
});

const protoProbe = base.channel(['proto-probe', 'proto:{id}'], {
  check(_ctx, input) {
    const d = input as { role?: unknown } | undefined;
    if (d?.role === 'admin') {
      throw new Error('admin role on subscribe payload is forbidden');
    }
  },
});

export const channelDynamicDefinition = base.assemble({
  handlers: [
    handleTopOnlyAction,
    handleTriggerServerSubscribeDynamic,
    handleSendMessage,
    handleEchoName,
    handleTriggerManualValidation,
    handleTriggerScopedError,
    protoProbe,
  ],
});

export type ChannelDynamicClient = InferClient<typeof channelDynamicDefinition>;
