import { event } from '@wskit/server';
import * as v from 'valibot';

export const SendChat = event('send-chat', v.object({ text: v.string() }));

export const ChatMessage = event(
  'chat-message',
  v.object({ text: v.string(), from: v.string(), ts: v.number() }),
);

export const GetChatInfo = event('get-chat-info', v.object({}));
export const ChatInfoSchema = v.object({ channel: v.string(), memberCount: v.number() });
