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
    const s = server('chat').outgoing(message);
    const def = s
      .use(s.channel('lobby', (c) => c.outgoing(roomMessage).incoming(roomSend, async () => {})))
      .build();

    expect(def.primitives.some((p) => p.__wskit === 'channel')).toBe(true);
  });

  it('adds channel primitive with dynamic scope', () => {
    const s = server('chat');
    const def = s
      .use(s.channel(scope('rooms', /^room-.+$/), (c) => c.outgoing(roomMessage)))
      .build();

    const channelPrim = def.primitives.find((p) => p.__wskit === 'channel') as unknown as {
      pattern: { key: string; pattern: RegExp };
    };
    expect(channelPrim.pattern.key).toBe('rooms');
  });

  it('types channel handler ctx with parent outgoing events', () => {
    server('chat')
      .ack()
      .outgoing(message)
      .channel(scope('rooms', /^room-.+$/), (c) =>
        c.outgoing(roomMessage).incoming(roomSend, async (ctx, payload) => {
          ctx.send('message', { text: 'hi' });
          ctx.send('room-message', { text: payload.text, from: 'system' });
        }),
      );
  });

  it('types channel handler ctx with channel-scoped outgoing', () => {
    server('chat').channel('lobby', (c) =>
      c.outgoing(roomMessage).incoming(roomSend, async (ctx) => {
        ctx.send('room-message', { text: 'hi', from: 'system' });

        // @ts-expect-error — 'message' not declared in this channel scope
        ctx.send('message', { text: 'hi' });
      }),
    );
  });

  it('supports channel lifecycle hooks', () => {
    const s = server('chat');
    const def = s
      .use(
        s.channel(scope('rooms', /^room-.+$/), (c) =>
          c
            .outgoing(roomMessage)
            .onBeforeSubscribe(async (_ctx, _data) => {})
            .onSubscribe(async (_ctx) => {})
            .onUnsubscribe(async (_ctx) => {}),
        ),
      )
      .build();

    const channelPrim = def.primitives.find((p) => p.__wskit === 'channel') as unknown as {
      primitives: readonly { __wskit: string }[];
    };
    expect(channelPrim.primitives.some((p) => p.__wskit === 'onBeforeSubscribe')).toBe(true);
    expect(channelPrim.primitives.some((p) => p.__wskit === 'onSubscribe')).toBe(true);
    expect(channelPrim.primitives.some((p) => p.__wskit === 'onUnsubscribe')).toBe(true);
  });

  it('callback form returns channel primitive for .use()', () => {
    const base = server('chat').outgoing(message);
    const def = base
      .use(base.channel('lobby', (c) => c.outgoing(roomMessage)))
      .incoming(sendMessage, async (ctx) => {
        ctx.send('message', { text: 'after channel' });
      })
      .build();

    expect(def.primitives).toHaveLength(3);
  });

  it('callback form returns channel primitive for multi-file', () => {
    const s = server('chat').ack().outgoing(message);
    const def = s
      .use(
        s.channel(scope('rooms', /^room-.+$/), (c) =>
          c.outgoing(roomMessage).incoming(roomSend, async (ctx) => {
            ctx.send('room-message', { text: 'hi', from: 'system' });
            ctx.send('message', { text: 'hi' });
          }),
        ),
      )
      .build();

    expect(def.primitives.some((p) => p.__wskit === 'channel')).toBe(true);
  });

  it('rejects duplicate channel scopes', () => {
    const s = server('chat');
    expect(() =>
      s
        .use(s.channel('lobby', (c) => c.outgoing(roomMessage)))
        .use(s.channel('lobby', (c) => c.outgoing(roomMessage)))
        .build(),
    ).toThrow(/Duplicate registration/);
  });
});
