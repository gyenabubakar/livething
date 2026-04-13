import '@wskit/server/channels';

import { base } from '../setup.ts';
import { ChatMessage, SendChat } from './events.ts';

export const chatChannel = base
  .channel('chat')
  .outgoing(ChatMessage)
  .incoming(SendChat, (ctx, payload) => {
    const msg = { text: payload.text, from: ctx.meta.username, ts: Date.now() };
    ctx.channel.send('chat-message', msg);
    ctx.channel.broadcast('chat-message', msg);
  })
  .onSubscribe((ctx) => {
    const msg = { text: `${ctx.meta.username} joined the chat`, from: 'system', ts: Date.now() };
    ctx.channel.send('chat-message', msg);
    ctx.channel.broadcast('chat-message', msg);
  })
  .onUnsubscribe((ctx) => {
    ctx.channel.broadcast('chat-message', {
      text: `${ctx.meta.username} left the chat`,
      from: 'system',
      ts: Date.now(),
    });
  })
  .extract();
