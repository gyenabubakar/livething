import * as v from 'valibot';

export const RoomMsg = v.object({ text: v.string(), from: v.string() });
export const SendRoomMsg = v.object({ text: v.string() });

export type RoomMsg = v.InferOutput<typeof RoomMsg>;
