import { event } from '@wskit/server';
import * as v from 'valibot';

export const ChatMsg = event('chat-msg', v.object({ text: v.string(), from: v.string() }));
export const SendMsg = event('send-msg', v.object({ text: v.string() }));
export const Cursor = event('cursor', v.object({ x: v.number(), y: v.number() }));
export const SendCursor = event('send-cursor', v.object({ x: v.number(), y: v.number() }));

export const RoomMsg = event('room-msg', v.object({ text: v.string(), from: v.string() }));
export const SendRoomMsg = event('send-room-msg', v.object({ text: v.string() }));
export const RequestHistory = event('request-history', v.object({}));
export const RequestRoomHistory = event('request-room-history', v.object({}));
