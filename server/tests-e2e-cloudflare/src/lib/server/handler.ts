import { event } from '@wskit/server';
import { withChannels } from '@wskit/server/channels';
import { Block, Defer, DeferExhausted, Skip, ValidationFailed } from '@wskit/server/errors';
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
import { Echo, GetTime, TimeResponseSchema } from './echo/events.ts';
import { echoHandlers } from './echo/handlers.ts';
import { DeadLetterResult, DefaultRetryResult, FilteredTaskResult } from './scheduled/events.ts';
import { scheduledHandlers } from './scheduled/handlers.ts';
import { base } from './setup.ts';
import { storageHandlers } from './storage/handlers.ts';

const DeferTest = event('defer-test', v.object({}));
const DeferResult = event('defer-result', v.object({ received: v.boolean() }));
const BlockTest = event('block-test', v.object({}));
const BlockReply = event('block-reply', v.object({ leaked: v.boolean() }));
const BinaryEchoed = event('binary-echoed', v.object({ size: v.number() }));
const ValidationErrorFired = event('validation-error-fired', v.object({ event: v.string() }));
const ChannelMembers = event(
  'channel-members',
  v.object({ channel: v.string(), count: v.number() }),
);
const GetChannelMembers = event('get-channel-members', v.object({ channel: v.string() }));
const KickFromChannel = event(
  'kick-from-channel',
  v.object({ channel: v.string(), tag: v.string() }),
);

const SkipTest = event('skip-test', v.object({}));
const SkipReply = event('skip-reply', v.object({ leaked: v.boolean() }));
const AckThenThrow = event('ack-then-throw', v.object({}));
const BinaryMeta = event('binary-meta', v.object({ size: v.number(), username: v.string() }));
const QueryDeadLetter = event('query-dead-letter', v.object({}));
const ManualValidation = event('manual-validation-test', v.object({ value: v.string() }));
const AlwaysDefer = event('always-defer', v.object({}));
const DeferExhaustedResult = event(
  'defer-exhausted-result',
  v.object({ event: v.string(), retries: v.number() }),
);

export const handler = withStreams(withChannels(withScheduled(withRequests(withIntercept(base)))))
  .outgoing(DeferResult)
  .outgoing(BlockReply)
  .outgoing(BinaryEchoed)
  .outgoing(ValidationErrorFired)
  .outgoing(ChannelMembers)
  .outgoing(SkipReply)
  .outgoing(DeferExhaustedResult)
  .outgoing(BinaryMeta)
  .outgoing(DeadLetterResult)
  .outgoing(DefaultRetryResult)
  .outgoing(FilteredTaskResult)

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

  .onError((ctx, error, evt) => {
    if (DeferExhausted.matches(error)) {
      ctx.send('defer-exhausted-result', {
        event: evt ?? 'unknown',
        retries: error.detail.retries,
      });
      return;
    }
    console.error(`[wskit] error in ${evt}:`, error);
  })

  .onBinary((ctx, data) => {
    ctx.sendBinary(data);
    ctx.send('binary-echoed', { size: data.byteLength });
    ctx.send('binary-meta', {
      size: data.byteLength,
      username: (ctx.meta.username as string) ?? '',
    });
  })

  .onValidationError((ctx, evt) => {
    ctx.send('validation-error-fired', { event: evt });
  })

  .intercept((_ctx, message) => {
    if (message.event === 'block-test') throw Block;
    if (message.event === 'skip-test') throw Skip;
    return message;
  })
  .intercept(Echo, (_ctx, payload) => {
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

  .incoming(AlwaysDefer, () => {
    throw Defer(50);
  })

  .incoming(BlockTest, (ctx) => {
    ctx.send('block-reply', { leaked: true });
  })

  .incoming(SkipTest, (ctx) => {
    ctx.send('skip-reply', { leaked: true });
  })

  .incoming(ManualValidation, (_ctx, payload) => {
    if (payload.value === 'invalid') throw ValidationFailed;
  })

  .incoming(AckThenThrow, () => {
    throw new Error('post-ack failure');
  })

  .incoming(GetChannelMembers, (ctx, payload) => {
    const members = ctx.channels.members(payload.channel);
    ctx.send('channel-members', { channel: payload.channel, count: members.length });
  })

  .incoming(KickFromChannel, (ctx, payload) => {
    ctx.channels.kick(payload.channel, payload.tag, 'Kicked by admin');
  })

  .incoming(QueryDeadLetter, (ctx) => {
    const rows = ctx.sql
      .exec(
        'SELECT taskId, attempts, error FROM _wskit_scheduled_dlq ORDER BY failedAt DESC LIMIT 1',
      )
      .toArray() as { taskId: string; attempts: number; error: string }[];
    const row = rows[0];
    if (row) {
      const err = JSON.parse(row.error) as { message: string };
      ctx.send('dead-letter-result', {
        taskId: row.taskId,
        attempts: row.attempts,
        error: err.message,
      });
    }
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
