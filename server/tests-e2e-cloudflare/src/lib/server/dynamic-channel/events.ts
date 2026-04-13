import { event } from '@wskit/server';
import * as v from 'valibot';

export const RoomSend = event('room-send', v.object({ text: v.string() }));
export const RoomMessage = event(
  'room-message',
  v.object({ text: v.string(), from: v.string(), room: v.string() }),
);
