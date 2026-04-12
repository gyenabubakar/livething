import { server } from '~/_builder/server-builder.ts';
import { scope } from '~/channel/channel.ts';
import { event } from '~/event.ts';
import { describe, expect, it } from 'vitest';

import '~/_builder/side-effects/ack.ts';
import '~/_builder/side-effects/channels.ts';

const message = event('message', (p: unknown) => p as { text: string });
const sendMessage = event('send-message', (p: unknown) => p as { text: string });
const roomMessage = event('room-message', (p: unknown) => p as { text: string; from: string });
const roomSend = event('room-send', (p: unknown) => p as { text: string });

describe('.channel() side-effect', () => {
  it('adds channel primitive with static name', () => {
    const def = server('chat')
      .outgoing(message)
      .channel('lobby')
      .outgoing(roomMessage)
      .incoming(roomSend, async () => {})
      .done()
      .done();

    expect(def.primitives.some((p) => p.__wskit === 'channel')).toBe(true);
  });

  it('adds channel primitive with dynamic scope', () => {
    const def = server('chat')
      .channel(scope('rooms', /^room-.+$/))
      .outgoing(roomMessage)
      .done()
      .done();

    const channelPrim = def.primitives.find((p) => p.__wskit === 'channel') as unknown as {
      pattern: { key: string; pattern: RegExp };
    };
    expect(channelPrim.pattern.key).toBe('rooms');
  });

  it('types channel handler ctx with parent outgoing events', () => {
    server('chat')
      .ack()
      .outgoing(message)
      .channel(scope('rooms', /^room-.+$/))
      .outgoing(roomMessage)
      .incoming(roomSend, async (ctx, payload) => {
        ctx.send('message', { text: 'hi' });
        ctx.send('room-message', { text: payload.text, from: 'system' });
      })
      .done();
  });

  it('types channel handler ctx with channel-scoped outgoing', () => {
    server('chat')
      .channel('lobby')
      .outgoing(roomMessage)
      .incoming(roomSend, async (ctx) => {
        ctx.send('room-message', { text: 'hi', from: 'system' });

        // @ts-expect-error — 'message' not declared in this channel scope
        ctx.send('message', { text: 'hi' });
      })
      .done();
  });

  it('supports channel lifecycle hooks', () => {
    const def = server('chat')
      .channel(scope('rooms', /^room-.+$/))
      .outgoing(roomMessage)
      .onBeforeSubscribe(async (_ctx, _data) => {})
      .onSubscribe(async (_ctx) => {})
      .onUnsubscribe(async (_ctx) => {})
      .done()
      .done();

    const channelPrim = def.primitives.find((p) => p.__wskit === 'channel') as unknown as {
      primitives: readonly { __wskit: string }[];
    };
    expect(channelPrim.primitives.some((p) => p.__wskit === 'onBeforeSubscribe')).toBe(true);
    expect(channelPrim.primitives.some((p) => p.__wskit === 'onSubscribe')).toBe(true);
    expect(channelPrim.primitives.some((p) => p.__wskit === 'onUnsubscribe')).toBe(true);
  });

  it('.done() returns to parent ServerBuilder', () => {
    const def = server('chat')
      .outgoing(message)
      .channel('lobby')
      .outgoing(roomMessage)
      .done()
      .incoming(sendMessage, async (ctx) => {
        ctx.send('message', { text: 'after channel' });
      })
      .done();

    expect(def.primitives).toHaveLength(3);
  });

  it('.extract() returns ChannelPrimitive for multi-file', () => {
    const base = server('chat').ack().outgoing(message);

    const rooms = base
      .channel(scope('rooms', /^room-.+$/))
      .outgoing(roomMessage)
      .incoming(roomSend, async (ctx) => {
        ctx.send('room-message', { text: 'hi', from: 'system' });
        ctx.send('message', { text: 'hi' });
      })
      .extract();

    expect(rooms.__wskit).toBe('channel');

    const def = base.use(rooms).done();
    expect(def.primitives.some((p) => p.__wskit === 'channel')).toBe(true);
  });

  it('rejects duplicate channel scopes', () => {
    expect(() =>
      server('chat')
        .channel('lobby')
        .outgoing(roomMessage)
        .done()
        .channel('lobby')
        .outgoing(roomMessage)
        .done()
        .done(),
    ).toThrow(/Duplicate registration/);
  });
});
