import { t } from '~/_api/index.ts';
import { define } from '~/_define/define.ts';
import { channels } from '~/channel/capability.ts';
import { dedup } from '~/dedup/capability.ts';
import { emits } from '~/emits/emits.ts';
import { inbox } from '~/inbox/capability.ts';
import { sequence } from '~/sequence/capability.ts';

const base = define({
  env: t<Record<string, never>>(),
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
      { event: 'message', payload: { text: 'hello' }, __wskit: { seq: 1, messageId: 'm1' } },
      { event: 'count', payload: { value: 2 }, __wskit: { seq: 2, messageId: 'm2' } },
    ]);

    ctx.channel.inbox.backfill('user-1', [
      {
        event: 'message',
        // @ts-expect-error — a declared event must receive its declared payload.
        payload: { value: 2 },
        __wskit: { seq: 3, messageId: 'm3' },
      },
    ]);

    ctx.channel.inbox.backfill('user-1', [
      {
        // @ts-expect-error — backfill only accepts events declared by this channel.
        event: 'missing',
        payload: { text: 'nope' },
        __wskit: { seq: 4, messageId: 'm4' },
      },
    ]);
  },
});

export type {};
