import * as v from 'valibot';

export const Note = v.object({ text: v.string(), author: v.string() });
export const AddNote = v.object({ text: v.string() });
export const GetConfirmedCount = v.object({});
export const ConfirmedCount = v.object({ total: v.number(), confirmed: v.number() });

export const RoomNote = v.object({ text: v.string(), author: v.string() });
export const AddRoomNote = v.object({ text: v.string() });
export const GetRoomConfirmedCount = v.object({});
export const RoomConfirmedCount = v.object({ total: v.number(), confirmed: v.number() });

export const QueryBadReplayLog = v.object({});
export const BadReplayLog = v.object({ undeclared: v.string(), reservedField: v.string() });

export const RoomStreamPayload = v.object({ count: v.number() });
export const RoomStreamChunk = v.object({ token: v.string() });
export const QueryRoomReplayEvents = v.object({});
export const RoomReplayEvents = v.object({ events: v.array(v.string()) });
