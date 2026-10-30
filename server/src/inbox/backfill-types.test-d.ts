import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { channels } from '~/channel/capability.ts';
import { dedup } from '~/dedup/capability.ts';
import { emits } from '~/emits/emits.ts';
import { inbox } from '~/inbox/capability.ts';
import { sequence } from '~/sequence/capability.ts';

const base = server({
  capabilities: [channels(), sequence({ persist: true }), dedup()],
});

const chat = base.channel('chat', {
  capabilities: [
    emits({
      message: t<{ text: string }>(),
      count: t<{ value: number }>(),
    }),
    inbox(),
  ],
});

export const handleConnectionClose = base.on('close', {
  run(ctx) {
    ctx.connections.get(ctx.connection).close(4000, 'bye');
  },
});

export const backfillTypes = chat.on('seed', {
  run(ctx) {
    ctx.channel.inbox.backfill('user-1', []);
    ctx.channel.inbox.backfill('user-1', [
      { event: 'message', payload: { text: 'hello' }, __livething: { messageId: 'm1' } },
      { event: 'count', payload: { value: 2 }, __livething: { messageId: 'm2' } },
    ]);

    ctx.channel.inbox.backfill('user-1', [
      {
        event: 'message',
        payload: { text: 'hello' },
        // @ts-expect-error — the server picks each backfilled message's delivery seq.
        __livething: { deliverySeq: 3, messageId: 'm3' },
      },
    ]);

    ctx.channel.inbox.backfill('user-1', [
      {
        event: 'message',
        // @ts-expect-error — a declared event must receive its declared payload.
        payload: { value: 2 },
        __livething: { messageId: 'm4' },
      },
    ]);

    ctx.channel.inbox.backfill('user-1', [
      {
        // @ts-expect-error — backfill only accepts events declared by this channel.
        event: 'missing',
        payload: { text: 'nope' },
        __livething: { messageId: 'm5' },
      },
    ]);
  },
});

export type {};
