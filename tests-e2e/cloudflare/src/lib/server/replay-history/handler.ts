import {
  channel,
  contract,
  implement,
  incoming,
  namespace,
  outgoing,
  request,
  scope,
  stream,
  t,
} from '@wskit/server';
import { RejectUpgrade } from '@wskit/server/errors';
import type { InferClient } from '@wskit/server';
import {
  ChatMsg,
  Cursor,
  GetToken,
  InjectFamilyReplay,
  ReplayGuardError,
  RequestHistory,
  RequestRoomHistory,
  RoomMsg,
  SendCursor,
  SendMsg,
  SendRoomMsg,
  StartTinyStream,
  TinyChunk,
  TokenResponse,
  TriggerBadReplay,
  TriggerBigIntReplay,
} from './events.ts';

export const replayContract = contract<Env>('replay-test')({
  sequence: { persist: true },
  dedup: true,
  replay: {
    exclude: ['cursor'],
    retention: { maxMessages: 100, maxAgeMs: 1_000 },
    durability: 'strict',
  },
  meta: t<{ username: string }>(),
  errors: [],
  definitions: [
    incoming('send-msg', SendMsg),
    incoming('send-cursor', SendCursor),
    incoming('request-history', RequestHistory),
    incoming('trigger-bad-replay', TriggerBadReplay),
    incoming('inject-family-replay', InjectFamilyReplay),
    incoming('trigger-bigint-replay', TriggerBigIntReplay),

    outgoing('chat-msg', ChatMsg),
    outgoing('cursor', Cursor),
    outgoing('room-msg', RoomMsg),
    outgoing('replay-guard-error', ReplayGuardError),

    request('get-token', { payload: GetToken, response: TokenResponse }),
    stream('start-tiny-stream', { payload: StartTinyStream, chunk: TinyChunk }),

    namespace('admin', {
      definitions: [outgoing('chat-msg', ChatMsg)],
    }),

    channel('replay-room', {
      replay: true,
      definitions: [
        outgoing('room-msg', RoomMsg),
        incoming('send-room-msg', SendRoomMsg),
        incoming('request-room-history', RequestRoomHistory),
      ],
    }),

    channel(scope('fams', /^fam-.+$/), {
      definitions: [outgoing('room-msg', RoomMsg), incoming('send-room-msg', SendRoomMsg)],
    }),
  ],
});

export const replayHandler = implement(replayContract)
  .onError((_ctx, error, event) => {
    console.error(`[replay] error in ${event}:`, error);
  })
  .onUpgrade((request) => {
    const url = new URL(request.url);
    const username = url.searchParams.get('username');
    if (!username) throw RejectUpgrade(4001, 'Missing username');
    return { identity: username, meta: { username } };
  })
  .on('send-msg', (ctx, payload) => {
    const msg = { text: payload.text, from: ctx.meta.username };
    ctx.send('chat-msg', msg);
    ctx.broadcast('chat-msg', msg);
  })
  .on('send-cursor', (ctx, payload) => {
    ctx.send('cursor', { x: payload.x, y: payload.y });
    ctx.broadcast('cursor', { x: payload.x, y: payload.y });
  })
  .on('request-history', (ctx) => {
    ctx.sendReplay(
      'chat-msg',
      { text: 'injected-history', from: 'system' },
      { seq: 0, messageId: 'manual-001' },
    );
  })
  .request('get-token', (ctx) => {
    return { token: `secret-for-${ctx.meta.username}` };
  })
  .on('trigger-bad-replay', (ctx) => {
    let undeclared = '';
    try {
      (ctx.sendReplay as (e: string, p: unknown, w: unknown) => void)(
        'not-declared-event',
        { text: 'x', from: 'system' },
        { seq: 0, messageId: 'bad-1' },
      );
    } catch (err) {
      undeclared = err instanceof Error ? err.message : String(err);
    }
    ctx.send('replay-guard-error', { undeclared });
  })
  .on('inject-family-replay', (ctx) => {
    ctx.sendReplay(
      'room-msg',
      { text: 'family-injected', from: 'system' },
      { seq: 0, messageId: 'fam-manual-001', channel: 'fam-1', channelScope: 'fams' },
    );
  })
  .on('trigger-bigint-replay', (ctx) => {
    ctx.sendReplay(
      'chat-msg',
      { text: 'bigint-row', from: 'system', reactions: 7n } as unknown as {
        text: string;
        from: string;
      },
      { seq: 1, messageId: 'bigint-row-1' },
    );
    ctx.sendReplay(
      'chat-msg',
      { text: 'after-bigint-row', from: 'system' },
      { seq: 2, messageId: 'after-bigint-row' },
    );
  })
  .stream('start-tiny-stream', async function* () {
    yield { value: 'one' };
  })
  .channel('replay-room', (ch) =>
    ch
      .on('send-room-msg', (ctx, payload) => {
        const from = ctx.meta.username;
        const msg = { text: payload.text, from };
        ctx.channel.send('room-msg', msg);
        ctx.channel.broadcast('room-msg', msg);
      })
      .on('request-room-history', (ctx) => {
        ctx.channel.sendReplay!(
          'room-msg',
          { text: 'injected-room-history', from: 'system' },
          { seq: 0, messageId: 'room-manual-001' },
        );
      }),
  )
  .channel('fams', (ch) =>
    ch.on('send-room-msg', (ctx, payload) => {
      const from = ctx.meta.username;
      const msg = { text: payload.text, from };
      ctx.channel.broadcast('room-msg', msg);
    }),
  )
  .build();

export type ReplayClient = InferClient<typeof replayHandler>;
