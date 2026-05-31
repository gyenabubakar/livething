import { contract, implement, incoming, outgoing, t } from '@wskit/server';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

export const ctxSendContract = contract('ctx-send', {
  env: t<Env>(),
  meta: t<{ username: string }>(),
  tags: (ephemeral) => [ephemeral('user', t<string>()), ephemeral('label', t<string>())],
  definitions: [
    incoming('do-broadcast', v.object({ text: v.string() })),
    incoming('do-broadcast-exclude-self', v.object({ text: v.string() })),
    incoming('do-send-to', v.object({ tag: v.string(), text: v.string() })),
    incoming('do-send-to-empty', v.object({ text: v.string() })),
    incoming('do-send-to-connection', v.object({ connectionId: v.string(), text: v.string() })),
    incoming('who-am-i', v.object({})),
    incoming('do-server-close', v.object({})),

    outgoing('message', v.object({ text: v.string(), from: v.string() })),
    outgoing('who-am-i-result', v.object({ connectionId: v.string() })),
    outgoing('delivery-status', v.object({ delivered: v.boolean() })),
  ],
});

export const ctxSendHandler = implement(ctxSendContract)
  .onUpgrade((request, helpers) => requireUsername(request, helpers))
  .on('do-broadcast', (ctx, payload) => {
    ctx.broadcast('message', { text: payload.text, from: ctx.meta.username });
  })
  .on('do-broadcast-exclude-self', (ctx, payload) => {
    ctx.broadcast(
      'message',
      { text: payload.text, from: ctx.meta.username },
      { excludeSelf: false },
    );
  })
  .on('do-send-to', (ctx, payload) => {
    ctx.tags
      .ephemeral('user')
      .ref(payload.tag)
      .send('message', { text: payload.text, from: ctx.meta.username });
  })
  .on('do-send-to-empty', (ctx, payload) => {
    ctx.tags
      .ephemeral('user')
      .ref('')
      .send('message', { text: payload.text, from: ctx.meta.username });
  })
  .on('do-send-to-connection', (ctx, payload) => {
    const delivered = ctx.sendToConnection(payload.connectionId, 'message', {
      text: payload.text,
      from: ctx.meta.username,
    });
    ctx.send('delivery-status', { delivered });
  })
  .on('who-am-i', (ctx) => {
    ctx.send('who-am-i-result', { connectionId: ctx.id });
  })
  .on('do-server-close', (ctx) => {
    ctx.close(4010, 'server-close');
  })
  .build();

export type CtxSendClient = InferClient<typeof ctxSendHandler>;
