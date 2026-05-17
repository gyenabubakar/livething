import { event, server } from '@wskit/server';
import { withLifecycle } from '@wskit/server/lifecycle';
import { withTags } from '@wskit/server/tags';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const DoBroadcast = event('do-broadcast', v.object({ text: v.string() }));
const DoBroadcastExcludeSelf = event('do-broadcast-exclude-self', v.object({ text: v.string() }));
const DoSendTo = event('do-send-to', v.object({ tag: v.string(), text: v.string() }));
const DoSendToEmpty = event('do-send-to-empty', v.object({ text: v.string() }));
const DoSendToConnection = event(
  'do-send-to-connection',
  v.object({ connectionId: v.string(), text: v.string() }),
);
const WhoAmI = event('who-am-i', v.object({}));
const DoServerClose = event('do-server-close', v.object({}));

const Message = event('message', v.object({ text: v.string(), from: v.string() }));
const WhoAmIResult = event('who-am-i-result', v.object({ connectionId: v.string() }));
const DeliveryStatus = event('delivery-status', v.object({ delivered: v.boolean() }));

export const ctxSendHandler = withTags(withLifecycle(server<Env>('ctx-send')))
  .tagGroups('ephemeral', ['user', 'label'])
  .outgoing(Message)
  .outgoing(WhoAmIResult)
  .outgoing(DeliveryStatus)
  .onUpgrade((request, helpers) => requireUsername(request, helpers))
  .incoming(DoBroadcast, (ctx, payload) => {
    ctx.broadcast('message', { text: payload.text, from: ctx.meta.username });
  })
  .incoming(DoBroadcastExcludeSelf, (ctx, payload) => {
    ctx.broadcast(
      'message',
      { text: payload.text, from: ctx.meta.username },
      { excludeSelf: false },
    );
  })
  .incoming(DoSendTo, (ctx, payload) => {
    // The test passes a username — match against the 'user' group set by
    // requireUsername on upgrade.
    ctx.tags
      .ephemeral('user')
      .ref(payload.tag)
      .send('message', { text: payload.text, from: ctx.meta.username });
  })
  .incoming(DoSendToEmpty, (ctx, payload) => {
    ctx.tags
      .ephemeral('user')
      .ref('')
      .send('message', { text: payload.text, from: ctx.meta.username });
  })
  .incoming(DoSendToConnection, (ctx, payload) => {
    const delivered = ctx.sendToConnection(payload.connectionId, 'message', {
      text: payload.text,
      from: ctx.meta.username,
    });
    ctx.send('delivery-status', { delivered });
  })
  .incoming(WhoAmI, (ctx) => {
    ctx.send('who-am-i-result', { connectionId: ctx.id });
  })
  .incoming(DoServerClose, (ctx) => {
    ctx.close(4010, 'server-close');
  })
  .build();
