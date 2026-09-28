/* oxlint-disable @typescript-eslint/no-unused-vars */
import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { channels } from '~/channel/capability.ts';
import { dedup } from '~/dedup/capability.ts';
import { emits } from '~/emits/emits.ts';
import { replay } from '~/replay/capability.ts';
import { sequence } from '~/sequence/capability.ts';
import { describe, expectTypeOf, it } from 'vitest';

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

describe('channel.replay(hooks) types', () => {
  const base = server({
    capabilities: [dedup(), sequence({ persist: true }), channels(), replay.custom()],
  });
  const room = base.channel('room');

  it('types channel hooks with the channel wire and the channel replay ctx', () => {
    room.replay({
      beforeBroadcast(_ctx, msg) {
        expectTypeOf(msg.wire.channel).toEqualTypeOf<string>();
        expectTypeOf(msg.wire.channelFamily).toEqualTypeOf<string | null>();
        expectTypeOf(msg.wire.deliverySeq).toEqualTypeOf<number>();
        expectTypeOf(msg.wire.messageId).toEqualTypeOf<string>();
      },
      afterBroadcast(_ctx, msg) {
        expectTypeOf(msg.wire.channel).toEqualTypeOf<string>();
      },
      replay(ctx, since) {
        expectTypeOf(ctx.channel.name).toEqualTypeOf<string>();
        expectTypeOf(since).toEqualTypeOf<number>();
        // @ts-expect-error — a channel replay ctx has no `request`; it names its channel.
        void ctx.request;
      },
    });
  });

  it('keeps the top-level hooks for base.replay', () => {
    base.replay({
      beforeBroadcast(_ctx, msg) {
        expectTypeOf(msg.wire.channel).toEqualTypeOf<string | null>();
      },
      afterBroadcast(_ctx, msg) {
        expectTypeOf(msg.wire.channel).toEqualTypeOf<string | null>();
      },
      replay(ctx) {
        expectTypeOf(ctx.request.channel).toEqualTypeOf<string | null>();
        // @ts-expect-error — a top-level replay ctx has no `channel`.
        void ctx.channel;
      },
    });
  });

  it('rejects hook names that are not part of the custom replay hooks', () => {
    base.replay({
      // @ts-expect-error — the store hooks are `beforeBroadcast` and `afterBroadcast`.
      beforeRecord() {},
      replay() {},
    });
    room.replay({
      // @ts-expect-error — the store hooks are `beforeBroadcast` and `afterBroadcast`.
      afterRecord() {},
      replay() {},
    });
  });
});
