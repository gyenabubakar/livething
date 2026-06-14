// Shared payload schemas. Imported by setup.ts (for the base emits) and rooms.ts
// (for the lobby channel handler) so the channel scope and the top-level scope
// agree on payload shapes.
import * as v from 'valibot';

export const RoomMessagePayload = v.object({ text: v.string(), from: v.string() });
export const SendRoomMessagePayload = v.object({ text: v.string() });
export const NotificationPayload = v.object({ title: v.string() });
