// A channel handler group defined in its own file. handler.ts imports this and
// mounts it with `.use()`. The channel's ctx is correctly typed against the
// contract (which includes ctx.meta.username) — proving type state survives
// the file boundary.
import { group } from '@wskit/server';
import { multifileContract } from './setup.ts';

export const rooms = group(multifileContract, (g) =>
  g.channel('lobby', (ch) =>
    ch.on('send-room-message', (ctx, payload) => {
      ctx.channel.broadcast('room-message', {
        text: payload.text,
        from: ctx.meta.username,
      });
    }),
  ),
);
