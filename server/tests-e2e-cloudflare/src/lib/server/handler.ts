import { event } from '@wskit/server';
import { withChannels } from '@wskit/server/channels';
import { Block, Defer } from '@wskit/server/errors';
import { withIntercept } from '@wskit/server/intercept';
import { withRequests } from '@wskit/server/requests';
import { withScheduled } from '@wskit/server/scheduled';
import { withStreams } from '@wskit/server/streams';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { aiNamespace } from './ai/namespace.ts';
import { chatChannel } from './chat/channel.ts';
import { connectionHandlers } from './connections/handlers.ts';
import { dynamicRoomChannel } from './dynamic-channel/channel.ts';
import { GetTime, TimeResponseSchema } from './echo/events.ts';
import { echoHandlers } from './echo/handlers.ts';
import { scheduledHandlers } from './scheduled/handlers.ts';
import { base } from './setup.ts';
import { storageHandlers } from './storage/handlers.ts';

const DeferTest = event('defer-test', v.object({}));
const DeferResult = event('defer-result', v.object({ received: v.boolean() }));
const BlockTest = event('block-test', v.object({}));
const BlockReply = event('block-reply', v.object({ leaked: v.boolean() }));
const BinaryEchoed = event('binary-echoed', v.object({ size: v.number() }));
const ValidationErrorFired = event('validation-error-fired', v.object({ event: v.string() }));
const StreamCancelAck = event('stream-cancel-ack', v.object({ cancelled: v.boolean() }));
const ChannelMembers = event(
  'channel-members',
  v.object({ channel: v.string(), count: v.number() }),
);
const GetChannelMembers = event('get-channel-members', v.object({ channel: v.string() }));
const KickFromChannel = event(
  'kick-from-channel',
  v.object({ channel: v.string(), tag: v.string() }),
);

export const handler = withStreams(withChannels(withScheduled(withRequests(withIntercept(base)))))
  .outgoing(DeferResult)
  .outgoing(BlockReply)
  .outgoing(BinaryEchoed)
  .outgoing(ValidationErrorFired)
  .outgoing(ChannelMembers)
  .outgoing(StreamCancelAck)

  .onInit((ctx) => {
    ctx.sql.exec(`
      CREATE TABLE IF NOT EXISTS notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        author TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    ctx.log.info('Database initialized');
  })

  .onConnect((ctx) => {
    ctx.broadcast('user-joined', { username: ctx.meta.username });
  })

  .onDisconnect((ctx) => {
    ctx.broadcast('user-left', { username: ctx.meta.username });
  })

  .onShutdown((ctx) => {
    ctx.broadcast('user-left', { username: 'server-shutdown' });
    ctx.log.info('Server shutting down', { connectionCount: ctx.connectionCount });
  })

  .onError((_ctx, error, event) => {
    console.error(`[wskit] error in ${event}:`, error);
  })

  .onBinary((ctx, data) => {
    ctx.sendBinary(data);
    ctx.send('binary-echoed', { size: data.byteLength });
  })

  .onValidationError((ctx, evt) => {
    ctx.send('validation-error-fired', { event: evt });
  })

  .intercept((_ctx, message) => {
    if (message.event === 'block-test') throw Block;
    return message;
  })
  .intercept('echo', (_ctx, payload) => {
    if (payload.text === 'intercept-rewrite') {
      return { ...payload, text: 'rewritten-by-intercept' };
    }
    return payload;
  })

  .request(GetTime, TimeResponseSchema, (ctx) => {
    ctx.respond({ iso: new Date().toISOString(), epoch: Date.now() });
  })

  .incoming(DeferTest, async (ctx) => {
    const key = `defer:${ctx.id}`;
    const attempts = ((await ctx.kv.get(key)) as number | undefined) ?? 0;
    await ctx.kv.set(key, attempts + 1);
    if (attempts < 1) throw Defer(100);
    await ctx.kv.delete(key);
    ctx.send('defer-result', { received: true });
  })

  .incoming(BlockTest, (ctx) => {
    ctx.send('block-reply', { leaked: true });
  })

  .incoming(GetChannelMembers, (ctx, payload) => {
    const members = ctx.channels.members(payload.channel);
    ctx.send('channel-members', { channel: payload.channel, count: members.length });
  })

  .incoming(KickFromChannel, (ctx, payload) => {
    ctx.channels.kick(payload.channel, payload.tag, 'Kicked by admin');
  })

  .use(echoHandlers)
  .use(scheduledHandlers)
  .use(storageHandlers)
  .use(connectionHandlers)
  .use(chatChannel)
  .use(dynamicRoomChannel)
  .use(aiNamespace)

  .build();

export type Client = InferClient<typeof handler>;
