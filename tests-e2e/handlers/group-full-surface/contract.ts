import { emits, localKey, server, t } from '@livething/server';
import { channels } from '@livething/server/channels';
import { clientRequests } from '@livething/server/client-requests';
import { dedup } from '@livething/server/dedup';
import { ValidationFailed } from '@livething/server/errors';
import { rateLimit } from '@livething/server/rate-limit';
import { scheduled } from '@livething/server/scheduled';
import { sequence } from '@livething/server/sequence';
import { recordedStream, stream } from '@livething/server/streams';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

export const ChatPayload = v.object({ text: v.string() });
export const LookupReq = v.object({ id: v.string() });
export const FeedChunk = t<{ idx: number }>();
export const TokenChunk = t<{ token: string }>();

export const SendMsgPayload = v.object({ text: v.string() });
export const RoomMsgPayload = v.object({ text: v.string(), from: v.string() });

export const BadPayload = v.object({ ok: v.literal(true) });

export const GroupRequestKey = localKey<{ tag: string }>('group-request');

export const base = server({
  upgrade: (request) => requireUsername(request),
  capabilities: [
    sequence({ persist: true }),
    dedup(),
    rateLimit(),
    clientRequests(),
    channels(),
    scheduled({ tick: null }),
    stream(),
    recordedStream(),
    emits({
      welcome: t<{ username: string }>(),
      goodbye: t<{ username: string }>(),
      'init-marker': t<{ ran: number }>(),
      'error-marker': t<{ event?: string | undefined; msg: string }>(),
      'validation-marker': t<{ event: string }>(),
      'pre-intercept-marker': t<{ event: string }>(),
      'post-intercept-marker': t<{ text: string }>(),
      'rl-marker': t<{ at: number }>(),
      'scheduled-marker': t<{ tickCount: number }>(),
    }),
  ],
  onInit(ctx) {
    ctx.sql.exec(
      'CREATE TABLE IF NOT EXISTS _init_check (id INTEGER PRIMARY KEY, ran INTEGER NOT NULL)',
    );
    ctx.sql.exec('INSERT OR REPLACE INTO _init_check (id, ran) VALUES (1, 1)');
    ctx.sql.exec(
      'CREATE TABLE IF NOT EXISTS _disconnect_log (id INTEGER PRIMARY KEY AUTOINCREMENT, identity TEXT NOT NULL, t INTEGER NOT NULL)',
    );
    ctx.sql.exec(
      'CREATE TABLE IF NOT EXISTS _scheduled_log (id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER NOT NULL)',
    );
  },
  onConnect(ctx) {
    ctx.send('welcome', { username: ctx.meta.username });
  },
  onDisconnect(ctx) {
    ctx.sql.exec(
      'INSERT INTO _disconnect_log (identity, t) VALUES (?, ?)',
      ctx.user.id,
      Date.now(),
    );
  },
  onError(ctx, err, eventName) {
    if (ValidationFailed.matches(err)) {
      ctx.send('validation-marker', { event: eventName ?? 'unknown' });
    }

    ctx.send('error-marker', {
      event: eventName,
      msg: err instanceof Error ? err.message : String(err),
    });
  },
  intercept(ctx, frame) {
    ctx.provide(GroupRequestKey, { tag: 'group' });
    ctx.send('pre-intercept-marker', { event: frame.event });
    // The v2 ctx has no payload-narrowing helper in the built dist yet, so gate
    // on frame.event/frame.kind and cast the raw payload (mirrors intercept/).
    if (frame.kind === 'incoming' && frame.event === 'chat') {
      const p = frame.payload as { text: string };
      ctx.send('post-intercept-marker', { text: p.text });
    }
  },
});
