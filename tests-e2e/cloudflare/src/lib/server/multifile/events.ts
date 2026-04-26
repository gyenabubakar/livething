// Shared event contracts. Imported by both setup.ts and rooms.ts so the
// channel scope and the top-level scope agree on payload shapes.
import { event } from '@wskit/server';
import * as v from 'valibot';

export const RoomMessage = event('room-message', v.object({ text: v.string(), from: v.string() }));
export const SendRoomMessage = event('send-room-message', v.object({ text: v.string() }));
export const Notification = event('notification', v.object({ title: v.string() }));
