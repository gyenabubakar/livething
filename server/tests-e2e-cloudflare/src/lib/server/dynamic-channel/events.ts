import { event } from '@wskit/server';
import * as v from 'valibot';

export const RoomSend = event('room-send', v.object({ text: v.string() }));
export const RoomMessage = event(
  'room-message',
  v.object({ text: v.string(), from: v.string(), room: v.string() }),
);

export const RoomEchoParam = event('room-echo-param', v.object({}));
export const RoomParamResult = event(
  'room-param-result',
  v.object({ name: v.string(), suffix: v.string() }),
);
