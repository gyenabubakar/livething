import { emits, server, t } from '@livething/server';
import { channels } from '@livething/server/channels';
import { dedup } from '@livething/server/dedup';
import { Disconnect } from '@livething/server/errors';
import { inbox } from '@livething/server/inbox';
import { sequence } from '@livething/server/sequence';
import * as v from 'valibot';
import type { InferClient } from '@livething/server';
import { requireUsername } from '../_shared/authenticate.ts';
import { SendRoomMsg } from './events.ts';
import type { RoomMsg } from './events.ts';

// Drives inbox OVERFLOW: `chat` keeps at most one undelivered row per member
// (`retention.maxMessages: 1`). While a member is offline, a second broadcast
// evicts the first held row and lifts that member's overflow watermark. On
// reconnect, the drain emits a `__gap__` before the surviving row and repeats it
// until `__received__` reaches the gap's `missedThrough` watermark. `inbox()`
// consumes and acknowledges the gap even without `replay()`; `replay()` owns the
// optional `onGap` callback that makes the loss visible to application code.
const base = server({
  authenticate: (request) => requireUsername(request),
  capabilities: [
    channels(),
    sequence({ persist: true }),
    dedup(),
    emits({
      'race-leave-hook-started': t<{ attempt: number }>(),
      'race-leave-hook-finished': t<{ attempt: number }>(),
    }),
  ],
});

export const handleServerDrop = base.on('server-drop', {
  input: v.object({}),
  run() {
    throw Disconnect(4500, 'test drop');
  },
});

const delayedRaceLeaves = new Map<string, () => void>();
const raceLeaveAttempts = new Map<string, number>();

const chat = base.channel('chat', {
  membership: 'persistent',
  capabilities: [
    inbox({ retention: { maxMessages: 1 }, broadcastReceipts: true }),
    emits({
      'room-msg': t<RoomMsg>(),
    }),
  ],
  // Keep the first two real leave confirmations under test control. The browser
  // duplicates the first leave frame so its early ack settles leave one; the
  // original hook remains blocked until the second leave is already pending.
  async onUnsubscribe(ctx) {
    if (ctx.meta.username !== 'race-alice') return;

    const connectionId = ctx.connection.id;
    const attempt = (raceLeaveAttempts.get(connectionId) ?? 0) + 1;
    raceLeaveAttempts.set(connectionId, attempt);
    ctx.send('race-leave-hook-started', { attempt });

    if (attempt <= 2) {
      await new Promise<void>((resolve) => {
        delayedRaceLeaves.set(`${connectionId}:${attempt}`, resolve);
      });
      delayedRaceLeaves.delete(`${connectionId}:${attempt}`);
    }

    ctx.send('race-leave-hook-finished', { attempt });
  },
});

export const handleReleaseRaceLeave = base.on('release-race-leave', {
  input: v.object({ attempt: v.number() }),
  run(ctx, payload) {
    delayedRaceLeaves.get(`${ctx.connection.id}:${payload.attempt}`)?.();
  },
});

const TriggerStaleUnsubscribeOk = v.object({});

export const handleSendRoomMsg = chat.on('send-room-msg', {
  input: SendRoomMsg,
  run(ctx, payload) {
    ctx.channel.broadcast('room-msg', { text: payload.text, from: ctx.meta.username });
  },
});

// Test seam: emit a channel-scoped unsubscribe confirmation after the client
// has rejoined. The missing correlation id makes channels() consume it as a
// malformed stale frame before receipt primitives can see it.
export const handleTriggerStaleUnsubscribeOk = chat.on('trigger-stale-unsubscribe-ok', {
  input: TriggerStaleUnsubscribeOk,
  run(ctx) {
    (
      ctx.channel as unknown as { send(event: string, payload: Record<string, never>): number }
    ).send('__unsubscribeOk__', {});
  },
});

// `chat` carries the `inbox: true` client-contract flag, so it is passed to
// `assemble` for `InferClient` to expose the inbox surface (receivers/receiversOf).
export const inboxGapDefinition = base.assemble({
  handlers: [
    handleServerDrop,
    handleReleaseRaceLeave,
    handleSendRoomMsg,
    handleTriggerStaleUnsubscribeOk,
    chat,
  ],
});

export type InboxGapClient = InferClient<typeof inboxGapDefinition>;
