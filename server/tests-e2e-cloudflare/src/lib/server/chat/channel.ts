import { withChannels } from '@wskit/server/channels';
import { Block } from '@wskit/server/errors';
import { withIntercept } from '@wskit/server/intercept';
import { withRequests } from '@wskit/server/requests';
import { withStreams } from '@wskit/server/streams';
import { base } from '../setup.ts';
import {
  ChatInfoSchema,
  ChatMessage,
  ChatStreamChunkSchema,
  ChatStreamPrompt,
  GetChatInfo,
  SendChat,
} from './events.ts';

const chatBase = withStreams(withRequests(withIntercept(withChannels(base))));

export const chatChannel = chatBase.channel('chat', (ch) =>
  ch
    .outgoing(ChatMessage)
    .incoming(SendChat, (ctx, payload) => {
      const msg = { text: payload.text, from: ctx.meta.username as string, ts: Date.now() };
      ctx.channel.send('chat-message', msg);
      ctx.channel.broadcast('chat-message', msg);
    })
    .intercept((_ctx, message) => {
      if (
        message.event === 'send-chat' &&
        message.payload &&
        typeof message.payload === 'object' &&
        (message.payload as { text?: string }).text === 'channel-pre-block'
      ) {
        throw Block;
      }
      return message;
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
    .stream(ChatStreamPrompt, ChatStreamChunkSchema, (s) =>
      s.generate(async function* (_ctx, payload) {
        const words = payload.prompt.split(' ');
        for (const word of words) {
          yield { token: word + ' ' };
          await new Promise((r) => setTimeout(r, 50));
        }
      }),
    )
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
