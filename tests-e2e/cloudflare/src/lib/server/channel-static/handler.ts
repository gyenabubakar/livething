import { event, server } from '@wskit/server';
import { withChannels } from '@wskit/server/channels';
import { withLifecycle } from '@wskit/server/lifecycle';
import { withStreams } from '@wskit/server/streams';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const RoomMessage = event(
  'room-message',
  v.object({ text: v.string(), from: v.string(), kind: v.string() }),
);
const SendMessage = event('send-message', v.object({ text: v.string() }));
const StartChannelStream = event('start-channel-stream', v.object({ count: v.number() }));
const ChannelToken = v.object({ index: v.number() });
// Triggers a ctx.channel.broadcast with a payload field that
// JSON.stringify cannot encode (BigInt). Pre-fix the throw escaped the
// broadcast loop and propagated out of the handler — the engine then
// routed an _error back to the triggering connection. Post-fix the
// broadcast logs internally and returns normally; no _error reaches
// the triggering connection and a follow-up valid broadcast still
// works on the same socket.
const TriggerBadBroadcast = event('trigger-bad-broadcast', v.object({}));
const TagSelf = event('tag-self', v.object({ tag: v.string() }));
const TagAck = event('tag-ack', v.object({ tag: v.string() }));
const KickByTag = event('kick-by-tag', v.object({ tag: v.string(), reason: v.string() }));
const KickAck = event('kick-ack', v.object({ tag: v.string() }));
// Triggers a server-initiated subscribe of the current connection into the
// 'room2' channel via channelHandle.subscribe(ctx.self). Used by the e2e
// suite to pin that the wire frame carries `source: 'server'` and that the
// connection is committed as a member without a client _subscribe frame.
const TriggerServerSubscribe = event('trigger-server-subscribe', v.object({}));

const base = withStreams(withChannels(withLifecycle(server<Env>('channel-static'))))
  .outgoing(TagAck)
  .outgoing(KickAck)
  .onUpgrade((request) => requireUsername(request))
  // A disconnect hook that throws for one specific username — used to pin
  // that handleConnectionClose contains the throw so the rest of the
  // close cleanup (channel leaves, _memberLeave fan-out) still runs.
  .onDisconnect((ctx) => {
    if (ctx.meta.username === 'throwing-user') {
      throw new Error('intentional onDisconnect throw');
    }
  });

const roomChannel = base.channel('room', (ch) =>
  ch
    .outgoing(RoomMessage)
    .incoming(SendMessage, (ctx, payload) => {
      ctx.channel.broadcast('room-message', {
        text: payload.text,
        from: ctx.meta.username,
        kind: 'user',
      });
    })
    .incoming(TriggerBadBroadcast, (ctx) => {
      // Broadcast a payload that contains a BigInt. JSON.stringify will
      // throw on it for every peer. The engine must log per-peer and
      // never escape this handler.
      ctx.channel.broadcast('room-message', {
        text: 'bad',
        from: ctx.meta.username,
        kind: 'user',
        reactions: 1n,
      } as unknown as { text: string; from: string; kind: string });
    })
    .stream(StartChannelStream, (s) =>
      s.chunk(ChannelToken).generate(async function* (_ctx, payload) {
        for (let i = 0; i < payload.count; i++) {
          yield { index: i };
          await new Promise((r) => setTimeout(r, 30));
        }
      }),
    )
    .onBeforeSubscribe((ctx) => {
      if (ctx.meta.username === 'blocked-user') {
        throw new Error('blocked-user may not subscribe');
      }
    })
    .onSubscribe((ctx) => {
      // ctx.channel.name is the static name 'room' — verify it's accessible
      if (ctx.channel.name !== 'room') {
        throw new Error(`expected channel.name to be 'room', got ${ctx.channel.name}`);
      }
      // A username gated to throw so the e2e suite can pin that
      // onSubscribe is observational: _subscribeOk must already be sent
      // and the throw must surface as a separate _error addressed to
      // the channel scope. The subscription itself stays committed.
      if (ctx.meta.username === 'subscribe-thrower') {
        throw new Error('intentional onSubscribe throw');
      }
      ctx.channel.broadcast('room-message', {
        text: `${ctx.meta.username} entered`,
        from: 'system',
        kind: 'system',
      });
    })
    .onUnsubscribe((ctx) => {
      ctx.channel.broadcast('room-message', {
        text: `${ctx.meta.username} left`,
        from: 'system',
        kind: 'system',
      });
      // A username gated to throw so the e2e suite can pin that an
      // onUnsubscribe throw on close does NOT block: (1) the rest of
      // this channel's leave tail (peers must still see _memberLeave
      // for `room`), and (2) a different channel's leave for the same
      // connection (peers in `room2` must still see _memberLeave).
      if (ctx.meta.username.startsWith('leave-thrower')) {
        throw new Error('intentional onUnsubscribe throw');
      }
    }),
);

const roomTwoChannel = base.channel('room2', (ch) =>
  ch.outgoing(RoomMessage).incoming(SendMessage, (ctx, payload) => {
    ctx.channel.broadcast('room-message', {
      text: payload.text,
      from: ctx.meta.username,
      kind: 'user',
    });
  }),
);

export const channelStaticHandler = base
  .use(roomChannel)
  .use(roomTwoChannel)
  .incoming(TagSelf, (ctx, payload) => {
    ctx.tag(payload.tag);
    ctx.send('tag-ack', { tag: payload.tag });
  })
  .incoming(KickByTag, async (ctx, payload) => {
    await ctx.channels.get('room').kick(payload.tag, payload.reason);
    ctx.send('kick-ack', { tag: payload.tag });
  })
  .incoming(TriggerServerSubscribe, async (ctx) => {
    await ctx.channels.get('room2').subscribe(ctx.self);
  })
  .build();
