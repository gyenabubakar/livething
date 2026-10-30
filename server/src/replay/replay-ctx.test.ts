/* oxlint-disable @typescript-eslint/no-unused-vars */
import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { channels } from '~/channel/capability.ts';
import { dedup } from '~/dedup/capability.ts';
import { emits } from '~/emits/emits.ts';
import { replay } from '~/replay/capability.ts';
import { sequence } from '~/sequence/capability.ts';
import { describe, it } from 'vitest';

describe('top-level ctx.sendReplay types', () => {
  const base = server({
    capabilities: [
      emits({ note: t<{ text: string }>() }),
      dedup(),
      sequence({ persist: true }),
      replay.history(),
      channels(),
    ],
  });
  const lobby = base.channel('lobby', {
    capabilities: [emits({ 'lobby-note': t<{ body: string }>() })],
  });
  const rooms = base.channel(['rooms', 'room-{id}'], {
    capabilities: [emits({ 'room-note': t<{ body: string; at: number }>() })],
  });

  it('types a top-level replay by the top-level emits', () => {
    base.on('seed', {
      run(ctx) {
        ctx.sendReplay('note', { text: 'hi' }, { deliverySeq: 1, messageId: 'm1' });
        // @ts-expect-error — the payload must match the declared `note` payload.
        ctx.sendReplay('note', { body: 'hi' }, { deliverySeq: 1, messageId: 'm1' });
        // @ts-expect-error — `lobby-note` is a channel event, not a top-level one.
        ctx.sendReplay('lobby-note', { body: 'hi' }, { deliverySeq: 1, messageId: 'm1' });
      },
    });
  });

  it("types a channel-targeted replay by that channel's emits", () => {
    base.on('seed-channels', {
      run(ctx) {
        ctx.sendReplay(
          'lobby-note',
          { body: 'hi' },
          { deliverySeq: 1, messageId: 'm1', channel: lobby },
        );
        ctx.sendReplay(
          'room-note',
          { body: 'hi', at: 1 },
          { deliverySeq: 2, messageId: 'm2', channel: rooms.at({ id: '1' }) },
        );
        ctx.sendReplay(
          // @ts-expect-error — `room-note` belongs to the rooms family, not to lobby.
          'room-note',
          { body: 'hi', at: 1 },
          { deliverySeq: 3, messageId: 'm3', channel: lobby },
        );
        // @ts-expect-error — the payload must match the family's `room-note` payload.
        ctx.sendReplay(
          'room-note',
          { body: 'hi' },
          { deliverySeq: 4, messageId: 'm4', channel: rooms.at({ id: '1' }) },
        );
        // @ts-expect-error — a raw channel name is not a channel ref.
        ctx.sendReplay(
          'lobby-note',
          { body: 'hi' },
          { deliverySeq: 5, messageId: 'm5', channel: 'lobby' },
        );
      },
    });
  });
});
