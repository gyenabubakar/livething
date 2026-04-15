import { server } from '@wskit/server';
import { withDedup } from '@wskit/server/dedup';
import { RejectUpgrade } from '@wskit/server/errors';
import { withLifecycle } from '@wskit/server/lifecycle';
import { withReplay } from '@wskit/server/replay';
import { withSequence } from '@wskit/server/sequence';
import type { InferClient } from '@wskit/server';
import { ChatMsg, Cursor, SendCursor, SendMsg } from './events.ts';

export const replayHandler = withReplay(
  withLifecycle(withSequence(withDedup(server<Env>('replay-test')))),
)
  .sequence({ persist: true })
  .dedup()
  .outgoing(ChatMsg)
  .outgoing(Cursor)
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
  .build();

export type ReplayClient = InferClient<typeof replayHandler>;
