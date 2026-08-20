import { define, t } from '@wskit/server';
import { channels } from '@wskit/server/channels';
import { dedup } from '@wskit/server/dedup';
import { Disconnect } from '@wskit/server/errors';
import { inbox } from '@wskit/server/inbox';
import { sequence } from '@wskit/server/sequence';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';
import { SendRoomMsg } from './events.ts';
import type { RoomMsg } from './events.ts';

// Drives inbox OVERFLOW: `chat` keeps at most one undelivered row per member
// (`retention.maxMessages: 1`). While a member is offline, a second broadcast
// evicts the first held row and lifts that member's overflow watermark. On
// reconnect, the drain emits a `__gap__` before the surviving row and repeats it
// until `__received__` reaches the gap's `missedThrough` watermark. `inbox()`
// consumes and acknowledges the gap even without `replay()`; `replay()` owns the
// optional `onGap` callback that makes the loss visible to application code.
const base = define({
  env: t<Env>(),
  upgrade: (request) => requireUsername(request),
  capabilities: [channels(), sequence({ persist: true }), dedup()],
});

export const handleServerDrop = base.on('server-drop', {
  input: v.object({}),
  run() {
    throw Disconnect(4500, 'test drop');
  },
});

const chat = base.channel('chat', {
  membership: 'persistent',
  capabilities: [inbox({ retention: { maxMessages: 1 } })],
  outgoing: {
    emits: {
      'room-msg': t<RoomMsg>(),
    },
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
// has rejoined. The missing correlation id makes it stale to channels(), while
// the real wire frame still reaches inbox() through the public protocol path.
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
export const inboxGapHandler = base.assemble({
  handlers: [handleServerDrop, handleSendRoomMsg, handleTriggerStaleUnsubscribeOk, chat],
});

export type InboxGapClient = InferClient<typeof inboxGapHandler>;
