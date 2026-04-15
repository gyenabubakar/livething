import { server } from '@wskit/server';
import { withChannels } from '@wskit/server/channels';
import { withDedup } from '@wskit/server/dedup';
import { RejectUpgrade } from '@wskit/server/errors';
import { withLifecycle } from '@wskit/server/lifecycle';
import { withReplay } from '@wskit/server/replay';
import { withSequence } from '@wskit/server/sequence';
import type { InferClient } from '@wskit/server';
import {
  ChatMsg,
  Cursor,
  RequestHistory,
  RequestRoomHistory,
  RoomMsg,
  SendCursor,
  SendMsg,
  SendRoomMsg,
} from './events.ts';

const base = withChannels(
  withReplay(withLifecycle(withSequence(withDedup(server<Env>('replay-test'))))),
);

export const replayHandler = base
  .sequence({ persist: true })
  .dedup()
  .outgoing(ChatMsg)
  .outgoing(Cursor)
  .outgoing(RoomMsg)
  .replay((r) =>
    r.exclude('cursor').retention({ maxMessages: 100, maxAgeMs: 60_000 }).durability('strict'),
  )
  .onError((_ctx, error, event) => {
    console.error(`[replay] error in ${event}:`, error);
  })
  .onUpgrade((request) => {
    const url = new URL(request.url);
    const username = url.searchParams.get('username');
    if (!username) throw RejectUpgrade(4001, 'Missing username');
    return { meta: { username } };
  })
  .incoming(SendMsg, (ctx, payload) => {
    const msg = { text: payload.text, from: ctx.meta.username };
    ctx.send('chat-msg', msg);
    ctx.broadcast('chat-msg', msg);
  })
  .incoming(SendCursor, (ctx, payload) => {
    ctx.send('cursor', { x: payload.x, y: payload.y });
    ctx.broadcast('cursor', { x: payload.x, y: payload.y });
  })
  .incoming(RequestHistory, (ctx) => {
    ctx.sendReplay(
      'chat-msg',
      { text: 'injected-history', from: 'system' },
      {
        seq: 0,
        messageId: 'manual-001',
      },
    );
  })
  .use(
    base.channel('replay-room', (ch) =>
      ch
        .outgoing(RoomMsg)
        .replay((r) => r)
        .incoming(SendRoomMsg, (ctx, payload) => {
          const from = ctx.meta.username as string;
          const msg = { text: payload.text, from };
          ctx.channel.send('room-msg', msg);
          ctx.channel.broadcast('room-msg', msg);
        })
        .incoming(RequestRoomHistory, (ctx) => {
          ctx.channel.sendReplay(
            'room-msg',
            { text: 'injected-room-history', from: 'system' },
            { seq: 0, messageId: 'room-manual-001' },
          );
        }),
    ),
  )
  .build();

export type ReplayClient = InferClient<typeof replayHandler>;
