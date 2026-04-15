import { withChannels } from '@wskit/server/channels';
import { withIntercept } from '@wskit/server/intercept';
import { withRequests } from '@wskit/server/requests';
import { base } from '../setup.ts';
import { ChatInfoSchema, ChatMessage, GetChatInfo, SendChat } from './events.ts';

const chatBase = withRequests(withIntercept(withChannels(base)));

export const chatChannel = chatBase.channel('chat', (ch) =>
  ch
    .outgoing(ChatMessage)
    .incoming(SendChat, (ctx, payload) => {
      const msg = { text: payload.text, from: ctx.meta.username as string, ts: Date.now() };
      ctx.channel.send('chat-message', msg);
      ctx.channel.broadcast('chat-message', msg);
    })
    .intercept('send-chat', (_ctx, payload) => {
      if (payload.text === 'intercept-channel-test') {
        return { ...payload, text: 'channel-intercepted' };
      }
      return payload;
    })
    .request(GetChatInfo, ChatInfoSchema, (ctx) => {
      ctx.respond({ channel: ctx.channel.name, memberCount: 1 });
    })
    .onBeforeSubscribe((ctx) => {
      if (ctx.meta.username === 'blocked-user') {
        throw new Error('You are not allowed in chat');
      }
    })
    .onSubscribe((ctx) => {
      const msg = {
        text: `${ctx.meta.username} joined the chat`,
        from: 'system',
        ts: Date.now(),
      };
      ctx.channel.send('chat-message', msg);
      ctx.channel.broadcast('chat-message', msg);
    })
    .onUnsubscribe((ctx) => {
      ctx.channel.broadcast('chat-message', {
        text: `${ctx.meta.username} left the chat`,
        from: 'system',
        ts: Date.now(),
      });
    }),
);
