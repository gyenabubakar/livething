import { scope, server } from '@wskit/server';
import { withChannels } from '@wskit/server/channels';
import { withDedup } from '@wskit/server/dedup';
import { RejectUpgrade } from '@wskit/server/errors';
import { withLifecycle } from '@wskit/server/lifecycle';
import { withNamespaces } from '@wskit/server/namespaces';
import { withReplay } from '@wskit/server/replay';
import { withRequests } from '@wskit/server/requests';
import { withSequence } from '@wskit/server/sequence';
import { withStreams } from '@wskit/server/streams';
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
} from './events.ts';

const base = withChannels(
  withNamespaces(
    withStreams(
      withRequests(withReplay(withLifecycle(withSequence(withDedup(server<Env>('replay-test')))))),
    ),
  ),
);

const tinyStream = base.stream(StartTinyStream, (s) =>
  s.chunk(TinyChunk).generate(async function* () {
    yield { value: 'one' };
  }),
);

export const replayHandler = base
  .sequence({ persist: true })
  .dedup()
  .outgoing(ChatMsg)
  .outgoing(Cursor)
  .outgoing(RoomMsg)
  .outgoing(ReplayGuardError)
  .replay((r) =>
    r.exclude('cursor').retention({ maxMessages: 100, maxAgeMs: 1_000 }).durability('strict'),
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
  .request(GetToken, TokenResponse, (ctx) => {
    // Private 1:1 response. Replay must not persist this — a different client
    // calling _replay later would otherwise receive someone else's token.
    ctx.respond({ token: `secret-for-${ctx.meta.username}` });
  })
  .incoming(TriggerBadReplay, (ctx) => {
    let undeclared = '';
    let reservedField = '';
    try {
      (ctx.sendReplay as (e: string, p: unknown, w: unknown) => void)(
        'not-declared-event',
        { text: 'x', from: 'system' },
        { seq: 0, messageId: 'bad-1' },
      );
    } catch (err) {
      undeclared = err instanceof Error ? err.message : String(err);
    }
    try {
      ctx.sendReplay(
        'chat-msg',
        { text: 'x', from: 'system', _evil: 'leaked' } as unknown as { text: string; from: string },
        { seq: 0, messageId: 'bad-2' },
      );
    } catch (err) {
      reservedField = err instanceof Error ? err.message : String(err);
    }
    ctx.send('replay-guard-error', { undeclared, reservedField });
  })
  .incoming(InjectFamilyReplay, (ctx) => {
    // Top-level handler emits a replay frame addressed to a family channel.
    // The built-in replay primitive must forward channelScope so the resent
    // frame carries _channelScope on the wire and family routing survives.
    ctx.sendReplay(
      'room-msg',
      { text: 'family-injected', from: 'system' },
      { seq: 0, messageId: 'fam-manual-001', channel: 'fam-1', channelScope: 'fams' },
    );
  })
  .use(tinyStream)
  .use(base.namespace('admin', (n) => n.outgoing(ChatMsg)))
  .use(
    base.channel(scope('fams', /^fam-.+$/), (ch) =>
      ch.outgoing(RoomMsg).incoming(SendRoomMsg, (ctx, payload) => {
        const from = ctx.meta.username as string;
        const msg = { text: payload.text, from };
        ctx.channel.broadcast('room-msg', msg);
      }),
    ),
  )
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
