import { event } from '@wskit/server';
import * as v from 'valibot';

export const Note = event('note', v.object({ text: v.string(), author: v.string() }));
export const AddNote = event('add-note', v.object({ text: v.string() }));
export const GetConfirmedCount = event('get-confirmed-count', v.object({}));
export const ConfirmedCount = event(
  'confirmed-count',
  v.object({ total: v.number(), confirmed: v.number() }),
);

export const RoomNote = event('room-note', v.object({ text: v.string(), author: v.string() }));
export const AddRoomNote = event('add-room-note', v.object({ text: v.string() }));
export const GetRoomConfirmedCount = event('get-room-confirmed-count', v.object({}));
export const RoomConfirmedCount = event(
  'room-confirmed-count',
  v.object({ total: v.number(), confirmed: v.number() }),
);

// Pin custom replay's ctx.sendReplay contract: try an undeclared event and
// a reserved "_"-prefixed payload field from inside onReplay, catch each
// throw, then surface both error messages to the client.
export const QueryBadReplayLog = event('query-bad-replay-log', v.object({}));
export const BadReplayLog = event(
  'bad-replay-log',
  v.object({ undeclared: v.string(), reservedField: v.string() }),
);
