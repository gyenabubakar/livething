import { event, scope, server } from '@wskit/server';
import { withChannels } from '@wskit/server/channels';
import { withDedup } from '@wskit/server/dedup';
import { withLifecycle } from '@wskit/server/lifecycle';
import { withReplayCustom } from '@wskit/server/replay/custom';
import { withSequence } from '@wskit/server/sequence';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const Note = event('note', v.object({ text: v.string() }));
const SendNote = event('send-note', v.object({ text: v.string() }));

const base = withChannels(
  withReplayCustom(withSequence(withDedup(withLifecycle(server<Env>('replay-custom-cascade'))))),
)
  .sequence({ persist: true })
  .dedup()
  .onUpgrade((request) => requireUsername(request));

// Top-level custom replay only. The channel does NOT register its own
// replayCustom — its messages cascade into the top-level hook. The hook
// must receive the channel name and channel scope on `wire` so it can
// persist scoped rows and serve them back accurately on replay.
export const replayCustomCascadeHandler = base
  .replayCustom((r) =>
    r
      .onBeforeSend((ctx, msg) => {
        ctx.sql.exec(
          'INSERT INTO _cascade_replay (event, payload, seq, message_id, channel, channel_scope) VALUES (?, ?, ?, ?, ?, ?)',
          msg.event,
          JSON.stringify(msg.payload),
          msg.wire.seq,
          msg.wire.messageId,
          msg.wire.channel,
          msg.wire.channelScope,
        );
      })
      .onReplay((ctx, since) => {
        // Filter by channel + channelScope when the replay request carries them.
        const requestedChannel = ctx.request.channel;
        const requestedScope = ctx.request.channelScope;
        const rows = requestedChannel
          ? ctx.sql
              .exec<{
                event: string;
                payload: string;
                seq: number;
                message_id: string;
                channel: string | null;
                channel_scope: string | null;
              }>(
                'SELECT event, payload, seq, message_id, channel, channel_scope FROM _cascade_replay WHERE seq > ? AND channel = ? AND ((channel_scope IS NULL AND ? IS NULL) OR channel_scope = ?) ORDER BY seq ASC',
                since,
                requestedChannel,
                requestedScope,
                requestedScope,
              )
              .toArray()
          : ctx.sql
              .exec<{
                event: string;
                payload: string;
                seq: number;
                message_id: string;
                channel: string | null;
                channel_scope: string | null;
              }>(
                'SELECT event, payload, seq, message_id, channel, channel_scope FROM _cascade_replay WHERE seq > ? AND channel IS NULL ORDER BY seq ASC',
                since,
              )
              .toArray();

        for (const row of rows) {
          ctx.sendReplay(row.event, JSON.parse(row.payload), {
            seq: row.seq,
            messageId: row.message_id,
            channel: row.channel ?? undefined,
            channelScope: row.channel_scope ?? null,
          });
        }
      }),
  )
  .onInit((ctx) => {
    ctx.sql.exec(`
      CREATE TABLE IF NOT EXISTS _cascade_replay (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event TEXT NOT NULL,
        payload TEXT NOT NULL,
        seq INTEGER NOT NULL,
        message_id TEXT NOT NULL,
        channel TEXT,
        channel_scope TEXT
      )
    `);
  })
  .use(
    base.channel('lobby', (c) =>
      c.outgoing(Note).incoming(SendNote, (ctx, payload) => {
        ctx.channel.send('note', { text: payload.text });
        ctx.channel.broadcast('note', { text: payload.text });
      }),
    ),
  )
  // Dynamic family with the same handler shape. Family channels carry
  // `_channelScope: 'rooms'` on every outgoing frame; replay frames must do
  // the same so client routing can target the family channel handler.
  .use(
    base.channel(scope('rooms', /^room-.+$/), (c) =>
      c.outgoing(Note).incoming(SendNote, (ctx, payload) => {
        ctx.channel.send('note', { text: payload.text });
        ctx.channel.broadcast('note', { text: payload.text });
      }),
    ),
  )
  .build();
