import { emits, server, t } from '@livething/server';
import { keepalive } from '@livething/server/keepalive';
import { tags } from '@livething/server/tags';
import * as v from 'valibot';
import type { InferClient } from '@livething/server';
import { requireUsernameWithUserTag } from '../_shared/authenticate.ts';

const base = server({
  authenticate: (request) => requireUsernameWithUserTag(request),
  capabilities: [
    keepalive(),
    tags((ephemeral) => [ephemeral('user', t<string>()), ephemeral('label', t<string>())]),
    emits({
      message: t<{ text: string; from: string }>(),
      'who-am-i-result': t<{ connectionId: string }>(),
      'delivery-status': t<{ delivered: boolean }>(),
    }),
  ],
});

const handleDoBroadcast = base.on('do-broadcast', {
  input: v.object({ text: v.string() }),
  run(ctx, input) {
    ctx.broadcast('message', { text: input.text, from: ctx.meta.username });
  },
});

const handleDoBroadcastExcludeSelf = base.on('do-broadcast-exclude-self', {
  input: v.object({ text: v.string() }),
  run(ctx, input) {
    ctx.broadcast('message', { text: input.text, from: ctx.meta.username }, { includeSelf: true });
  },
});

const handleDoSendTo = base.on('do-send-to', {
  input: v.object({ tag: v.string(), text: v.string() }),
  run(ctx, input) {
    ctx.tags
      .ephemeral('user')
      .ref(input.tag)
      .broadcast('message', { text: input.text, from: ctx.meta.username });
  },
});

const handleDoSendToEmpty = base.on('do-send-to-empty', {
  input: v.object({ text: v.string() }),
  run(ctx, input) {
    ctx.tags
      .ephemeral('user')
      .ref('')
      .broadcast('message', { text: input.text, from: ctx.meta.username });
  },
});

const handleDoSendToConnection = base.on('do-send-to-connection', {
  input: v.object({ connectionId: v.string(), text: v.string() }),
  run(ctx, input) {
    const target = ctx.connections.all().find((info) => info.id === input.connectionId);
    const delivered = target
      ? ctx.connections.get(target.ref()).send('message', {
          text: input.text,
          from: ctx.meta.username,
        })
      : false;
    ctx.send('delivery-status', { delivered });
  },
});

const handleWhoAmI = base.on('who-am-i', {
  input: v.object({}),
  run(ctx) {
    ctx.send('who-am-i-result', { connectionId: ctx.connection.id });
  },
});

const handleDoServerClose = base.on('do-server-close', {
  input: v.object({}),
  run(ctx) {
    ctx.close(4010, 'server-close');
  },
});

export const ctxSendDefinition = base.assemble({
  handlers: [
    handleDoBroadcast,
    handleDoBroadcastExcludeSelf,
    handleDoSendTo,
    handleDoSendToEmpty,
    handleDoSendToConnection,
    handleWhoAmI,
    handleDoServerClose,
  ],
});

export type CtxSendClient = InferClient<typeof ctxSendDefinition>;
