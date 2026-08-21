import * as v from 'valibot';

export const ChatMsg = v.object({ text: v.string(), from: v.string() });
export const SendMsg = v.object({ text: v.string() });

export const RoomMsg = v.object({ text: v.string(), from: v.string() });
export const SendRoomMsg = v.object({ text: v.string() });

export type ChatMsg = v.InferOutput<typeof ChatMsg>;
export type RoomMsg = v.InferOutput<typeof RoomMsg>;
