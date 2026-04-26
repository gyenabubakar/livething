// A channel primitive defined in its own file. The handler.ts file imports
// this and mounts it with `.use()`. The channel's ctx is correctly typed off
// `base`'s state (which includes ctx.meta.username from onUpgrade) — proving
// type state survives the file boundary.
import { RoomMessage, SendRoomMessage } from './events.ts';
import { base } from './setup.ts';

export const rooms = base.channel('lobby', (ch) =>
  ch.outgoing(RoomMessage).incoming(SendRoomMessage, (ctx, payload) => {
    ctx.channel.broadcast('room-message', {
      text: payload.text,
      from: ctx.meta.username,
    });
  }),
);
