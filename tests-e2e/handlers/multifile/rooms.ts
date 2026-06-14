// The lobby channel and its handler, defined in its own file. handler.ts
// imports the handler and passes it to `assemble()`, which drags the whole
// channel in by reference. The channel's ctx is typed against the base (which
// includes ctx.meta.username) — proving type state survives the file boundary.
import { base } from './setup.ts';
import { RoomMessagePayload, SendRoomMessagePayload } from './events.ts';

const lobby = base.channel('lobby', {
  outgoing: { emits: { 'room-message': RoomMessagePayload } },
});

export const handleSendRoomMessage = lobby.on('send-room-message', {
  input: SendRoomMessagePayload,
  run(ctx, input) {
    ctx.channel.broadcast('room-message', {
      text: input.text,
      from: ctx.meta.username,
    });
  },
});
