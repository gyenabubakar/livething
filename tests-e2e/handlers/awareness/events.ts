import * as v from 'valibot';

/** A room member's awareness state: the message they are reading, or `null` between messages. */
export const RoomAwareness = v.object({ viewingMessageId: v.nullable(v.string()) });

export type RoomAwareness = v.InferOutput<typeof RoomAwareness>;

export interface RoomViewer {
  connectionId: string;
  name: string;
  viewingMessageId: string | null;
}
