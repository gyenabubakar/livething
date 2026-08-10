import * as v from 'valibot';

export const RoomMsg = v.object({ text: v.string(), from: v.string() });
export const SendRoomMsg = v.object({ text: v.string() });
export const TopMsg = v.object({ text: v.string(), from: v.string() });
export const SendTopMsg = v.object({ text: v.string() });
export const AddFavorite = v.object({ key: v.string() });

export type RoomMsg = v.InferOutput<typeof RoomMsg>;
export type TopMsg = v.InferOutput<typeof TopMsg>;
