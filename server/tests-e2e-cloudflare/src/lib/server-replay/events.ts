import { event } from '@wskit/server';
import * as v from 'valibot';

export const ChatMsg = event('chat-msg', v.object({ text: v.string(), from: v.string() }));
export const SendMsg = event('send-msg', v.object({ text: v.string() }));
export const Cursor = event('cursor', v.object({ x: v.number(), y: v.number() }));
