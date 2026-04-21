import { event, server } from '@wskit/server';
import { withLifecycle } from '@wskit/server/lifecycle';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const DoSend = event('do-send', v.object({ text: v.string() }));
const DoBroadcast = event('do-broadcast', v.object({ text: v.string() }));
const DoSendTo = event('do-send-to', v.object({ tag: v.string(), text: v.string() }));
const DoSendToConnection = event(
  'do-send-to-connection',
  v.object({ connectionId: v.string(), text: v.string() }),
);
const Message = event('message', v.object({ text: v.string() }));

export const ctxSendHandler = withLifecycle(server<Env>('ctx-send'))
  .outgoing(Message)
  .onUpgrade((request) => requireUsername(request))
  .incoming(DoSend, (ctx, payload) => {
    ctx.send('message', { text: payload.text });
  })
  .incoming(DoBroadcast, (ctx, payload) => {
    ctx.broadcast('message', { text: payload.text });
  })
  .incoming(DoSendTo, (ctx, payload) => {
    ctx.sendTo(payload.tag, 'message', { text: payload.text });
  })
  .incoming(DoSendToConnection, (ctx, payload) => {
    ctx.sendToConnection(payload.connectionId, 'message', { text: payload.text });
  })
  .build();
