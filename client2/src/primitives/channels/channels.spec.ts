import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { ack } from '~/primitives/ack/index.ts';
import { channels } from '~/primitives/channels/index.ts';
import { reconnection } from '~/primitives/reconnection/index.ts';
import { requestResponse } from '~/primitives/request-response/index.ts';
import { stream } from '~/primitives/stream/index.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Primitive, ValidatePrimitives } from '~/primitives/types.ts';

interface C {
  channels: {
    general: {
      incoming: { message: { text: string }; typing: { who: string }; feed: { token: string } };
      outgoing: { 'send-message': { text: string } };
      requests: { history: { payload: { before: string }; response: { items: string[] } } };
    };
    rooms: {
      [room: string]: {
        incoming: { message: { text: string } };
        outgoing: { 'send-message': { text: string } };
      };
    };
  };
}

// oxlint-disable-next-line @typescript-eslint/no-explicit-any -- extra primitives' socket-level types unused in tests
function build<const P extends readonly Primitive<any, any>[]>(
  channelsPrimitive: ReturnType<typeof channels>,
  ...rest: [...P] & ValidatePrimitives<C, P>
) {
  const socket = client<C>()(connect('wss://test'), channelsPrimitive, ...rest);
  socket.connect();
  const ws = MockWebSocket.last();
  ws.open();
  return { socket, ws };
}

let restore: () => void;
beforeEach(() => {
  restore = installMockWebSocket();
});
afterEach(() => {
  restore();
});

describe('subscribe / unsubscribe', () => {
  it('sends __subscribe__ and resolves on __subscribeOk__', async () => {
    const { socket, ws } = build(channels());
    const room = socket.channel('general');
    const promise = room.subscribe();
    expect(ws.sentFrames().at(-1)).toEqual({
      event: '__subscribe__',
      payload: {},
      __wskit: { channel: 'general' },
    });
    ws.emit({
      event: '__subscribeOk__',
      payload: { source: 'client' },
      __wskit: { channel: 'general' },
    });
    await expect(promise).resolves.toBeUndefined();
  });

  it('passes subscribe data as the __subscribe__ payload', () => {
    const { socket, ws } = build(channels());
    socket.channel('general').subscribe({ orgId: 'o1' });
    expect(ws.sentFrames().at(-1).payload).toEqual({ orgId: 'o1' });
  });

  it('throws ChannelNotSubscribed when sending before active', () => {
    const { socket } = build(channels());
    expect(() => socket.channel('general').send('send-message', { text: 'hi' })).toThrow(
      /channel-not-subscribed/,
    );
  });

  it('tags sends with __wskit.channel once active', async () => {
    const { socket, ws } = build(channels());
    const room = socket.channel('general');
    const p = room.subscribe();
    ws.emit({
      event: '__subscribeOk__',
      payload: { source: 'client' },
      __wskit: { channel: 'general' },
    });
    await p;
    room.send('send-message', { text: 'hi' });
    expect(ws.sentFrames().at(-1)).toEqual({
      event: 'send-message',
      payload: { text: 'hi' },
      __wskit: { channel: 'general' },
    });
  });

  it('unsubscribe sends __unsubscribe__ and fires onUnsubscribed', async () => {
    const { socket, ws } = build(channels());
    const room = socket.channel('general');
    const p = room.subscribe();
    ws.emit({
      event: '__subscribeOk__',
      payload: { source: 'client' },
      __wskit: { channel: 'general' },
    });
    await p;
    const onUnsub = vi.fn();
    room.onUnsubscribed(onUnsub);
    room.unsubscribe();
    expect(ws.sentFrames().at(-1)).toEqual({
      event: '__unsubscribe__',
      payload: {},
      __wskit: { channel: 'general' },
    });
    expect(onUnsub).toHaveBeenCalled();
  });

  it('rejects a pending subscribe with Disconnected on disconnect', async () => {
    const { socket } = build(channels());
    const promise = socket.channel('general').subscribe();
    socket.disconnect();
    await expect(promise).rejects.toMatchObject({ code: 'disconnected' });
  });

  it('reuses the in-flight promise for an overlapping subscribe (no orphan, one frame)', async () => {
    const { socket, ws } = build(channels());
    const room = socket.channel('general');

    const first = room.subscribe();
    const second = room.subscribe(); // before __subscribeOk__

    // Same in-flight promise — not a second, orphaned one.
    expect(second).toBe(first);
    // Only one __subscribe__ frame went out.
    expect(ws.sentFrames().filter((f) => f.event === '__subscribe__')).toHaveLength(1);

    ws.emit({
      event: '__subscribeOk__',
      payload: { source: 'client' },
      __wskit: { channel: 'general' },
    });

    // Both awaiters settle.
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
  });

  it('subscribe again after an unsubscribe interrupted an in-flight subscribe starts fresh', async () => {
    const { socket, ws } = build(channels());
    const room = socket.channel('general');

    room.subscribe(); // in flight — no __subscribeOk__ yet
    room.unsubscribe(); // tears the channel down before confirmation

    function countSubscribeFrames() {
      return ws.sentFrames().filter((f) => f.event === '__subscribe__').length;
    }
    const before = countSubscribeFrames();

    const retry = room.subscribe(); // must NOT reuse the dead attempt
    expect(countSubscribeFrames()).toBe(before + 1);

    ws.emit({
      event: '__subscribeOk__',
      payload: { source: 'client' },
      __wskit: { channel: 'general' },
    });
    await expect(retry).resolves.toBeUndefined();
  });
});

describe('routing', () => {
  it('delivers channel events to channel handlers, not top-level', async () => {
    const { socket, ws } = build(channels());
    const room = socket.channel('general');
    const handler = vi.fn();
    room.on('message', handler);
    const p = room.subscribe();
    ws.emit({
      event: '__subscribeOk__',
      payload: { source: 'client' },
      __wskit: { channel: 'general' },
    });
    await p;
    ws.emit({ event: 'message', payload: { text: 'hi' }, __wskit: { channel: 'general' } });
    expect(handler).toHaveBeenCalledWith({ text: 'hi' });
  });

  it('lets listeners register before the channel is active', async () => {
    const { socket, ws } = build(channels());
    const room = socket.channel('general');
    const handler = vi.fn();
    room.on('message', handler); // before subscribe
    const p = room.subscribe();
    ws.emit({
      event: '__subscribeOk__',
      payload: { source: 'client' },
      __wskit: { channel: 'general' },
    });
    await p;
    ws.emit({ event: 'message', payload: { text: 'late' }, __wskit: { channel: 'general' } });
    expect(handler).toHaveBeenCalledWith({ text: 'late' });
  });

  it('does not deliver a channel-scoped stream chunk to channel.on()', async () => {
    const { socket, ws } = build(channels(), stream());
    const room = socket.channel('general');
    const handler = vi.fn();
    room.on('feed', handler);
    const p = room.subscribe();
    ws.emit({
      event: '__subscribeOk__',
      payload: { source: 'client' },
      __wskit: { channel: 'general' },
    });
    await p;
    ws.emit({
      event: 'feed',
      payload: { token: 'a' },
      __wskit: { channel: 'general', streamId: 's1', seq: 1 },
    });
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('membership and presence', () => {
  it('populates members from __memberSync__ and fires join + online', async () => {
    const { socket, ws } = build(channels());
    const room = socket.channel('general');
    const onJoin = vi.fn();
    const onOnline = vi.fn();
    room.onMemberJoin(onJoin);
    room.onMemberOnline(onOnline);
    const p = room.subscribe();
    ws.emit({
      event: '__subscribeOk__',
      payload: { source: 'client' },
      __wskit: { channel: 'general' },
    });
    await p;
    ws.emit({
      event: '__memberSync__',
      payload: { members: [{ connectionId: 'c1', meta: { name: 'Ada' } }] },
      __wskit: { channel: 'general' },
    });
    expect(room.members.get('c1')).toEqual({ meta: { name: 'Ada' } });
    expect(onJoin).toHaveBeenCalledWith('c1', { meta: { name: 'Ada' } });
    expect(onOnline).toHaveBeenCalledWith('c1', { meta: { name: 'Ada' } });
  });

  it('tracks incremental join and leave', async () => {
    const { socket, ws } = build(channels());
    const room = socket.channel('general');
    const onLeave = vi.fn();
    room.onMemberLeave(onLeave);
    const p = room.subscribe();
    ws.emit({
      event: '__subscribeOk__',
      payload: { source: 'client' },
      __wskit: { channel: 'general' },
    });
    await p;
    ws.emit({
      event: '__memberJoin__',
      payload: { connectionId: 'c2' },
      __wskit: { channel: 'general' },
    });
    expect(room.members.has('c2')).toBe(true);
    ws.emit({
      event: '__memberLeave__',
      payload: { connectionId: 'c2' },
      __wskit: { channel: 'general' },
    });
    expect(room.members.has('c2')).toBe(false);
    expect(onLeave).toHaveBeenCalledWith('c2');
  });

  it('fires onKicked and tears the subscription down', async () => {
    const { socket, ws } = build(channels());
    const room = socket.channel('general');
    const onKicked = vi.fn();
    room.onKicked(onKicked);
    const p = room.subscribe();
    ws.emit({
      event: '__subscribeOk__',
      payload: { source: 'client' },
      __wskit: { channel: 'general' },
    });
    await p;
    ws.emit({ event: '__kicked__', payload: { reason: 'spam' }, __wskit: { channel: 'general' } });
    expect(onKicked).toHaveBeenCalledWith('spam');
    expect(() => room.send('send-message', { text: 'x' })).toThrow(/channel-not-subscribed/);
  });
});

describe('dynamic families and scope handles', () => {
  it('tags dynamic channels with channel + channelScope', async () => {
    const { socket, ws } = build(channels());
    const room = socket.channel('rooms', 'room-1');
    const p = room.subscribe();
    expect(ws.sentFrames().at(-1)).toEqual({
      event: '__subscribe__',
      payload: {},
      __wskit: { channel: 'room-1', channelScope: 'rooms' },
    });
    ws.emit({
      event: '__subscribeOk__',
      payload: { source: 'client' },
      __wskit: { channel: 'room-1', channelScope: 'rooms' },
    });
    await p;
    room.send('send-message', { text: 'hi' });
    expect(ws.sentFrames().at(-1).__wskit).toEqual({ channel: 'room-1', channelScope: 'rooms' });
  });

  it('resolves the same handle via channel(scope,name) and scope(key)(name)', () => {
    const { socket } = build(channels());
    expect(socket.channel('rooms', 'room-1')).toBe(socket.channel.scope('rooms')('room-1'));
  });

  it('family-level on() fires with the channel name', async () => {
    const { socket, ws } = build(channels());
    const family = socket.channel.scope('rooms');
    const familyHandler = vi.fn();
    family.on('message', familyHandler);
    const room = family('room-7');
    const p = room.subscribe();
    ws.emit({
      event: '__subscribeOk__',
      payload: { source: 'client' },
      __wskit: { channel: 'room-7', channelScope: 'rooms' },
    });
    await p;
    ws.emit({
      event: 'message',
      payload: { text: 'yo' },
      __wskit: { channel: 'room-7', channelScope: 'rooms' },
    });
    expect(familyHandler).toHaveBeenCalledWith({ text: 'yo' }, 'room-7');
    expect(family.list()).toEqual(['room-7']);
  });
});

describe('server-initiated subscriptions and reconnection', () => {
  it('activates a channel from a server-pushed __subscribeOk__', () => {
    const { socket, ws } = build(channels());
    ws.emit({
      event: '__subscribeOk__',
      payload: { source: 'server' },
      __wskit: { channel: 'general' },
    });
    // A handle created afterwards is backed by the already-active state.
    const room = socket.channel('general');
    expect(() => room.send('send-message', { text: 'ok' })).not.toThrow();
  });

  it('re-subscribes active channels after a reconnect', () => {
    vi.useFakeTimers();
    try {
      const socket = client<C>()(connect('wss://test'), channels(), reconnection());
      socket.connect();
      const first = MockWebSocket.last();
      first.open();
      socket.channel('general').subscribe();
      first.emit({
        event: '__subscribeOk__',
        payload: { source: 'client' },
        __wskit: { channel: 'general' },
      });
      first.serverClose(1006, 'drop');
      vi.advanceTimersByTime(1500);
      const second = MockWebSocket.last();
      second.open();
      expect(second.sentFrames()).toContainEqual({
        event: '__subscribe__',
        payload: {},
        __wskit: { channel: 'general' },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('scoped request and ack', () => {
  it('channel request tags the channel and resolves', async () => {
    const { socket, ws } = build(channels(), requestResponse());
    const room = socket.channel('general');
    const p = room.subscribe();
    ws.emit({
      event: '__subscribeOk__',
      payload: { source: 'client' },
      __wskit: { channel: 'general' },
    });
    await p;
    const reqPromise = room.request('history', { before: 'x' });
    const frame = ws.sentFrames().at(-1);
    expect(frame.__wskit.channel).toBe('general');
    expect(typeof frame.__wskit.correlationId).toBe('string');
    ws.emit({
      event: 'history',
      payload: { items: ['a'] },
      __wskit: { correlationId: frame.__wskit.correlationId },
    });
    await expect(reqPromise).resolves.toEqual({ items: ['a'] });
  });

  it('channel sendWithAck is guarded before subscribe', () => {
    const { socket } = build(channels(), ack());
    expect(() => socket.channel('general').sendWithAck('send-message', { text: 'x' })).toThrow(
      /channel-not-subscribed/,
    );
  });
});

describe('stream-error routing (order-independent)', () => {
  it('routes a channel-scoped stream error to the stream primitive, not to channel subscribe-failure, even when channels is registered first', async () => {
    const { socket, ws } = build(channels(), stream());
    // stream() augments onStream onto channel endpoints at runtime; the general channel
    // has no streams in C, so we union-cast to access the augmented method in the test.
    type RoomWithStream = ReturnType<(typeof socket)['channel']> & {
      onStream(
        event: string,
        handlers: {
          onChunk(chunk: unknown, id: string): void;
          onError?(error: unknown, id: string): void;
          onEnd?: (id: string, seq?: number) => void;
        },
      ): () => void;
    };
    const room = socket.channel('general') as unknown as RoomWithStream;
    const p = room.subscribe();
    ws.emit({
      event: '__subscribeOk__',
      payload: { source: 'client' },
      __wskit: { channel: 'general' },
    });
    await p;

    const onSubFailed = vi.fn();
    room.onSubscriptionFailed(onSubFailed);

    const onChunk = vi.fn();
    const onError = vi.fn();
    room.onStream('ask-ai', { onChunk, onError, onEnd: vi.fn() });

    // A chunk starts the broadcast run...
    ws.emit({
      event: 'ask-ai',
      payload: { text: 'hi' },
      __wskit: { channel: 'general', streamId: 's1', seq: 0 },
    });
    // ...then a channel-scoped stream error.
    ws.emit({
      event: '__error__',
      payload: { code: 'internal-error' },
      __wskit: { channel: 'general', streamId: 's1', streamTerminated: true },
    });

    expect(onChunk).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1); // the stream primitive received the error
    expect(onSubFailed).not.toHaveBeenCalled(); // channels did NOT misroute it
  });
});

describe('lazy hold lifecycle (no leak)', () => {
  function lazySocket() {
    return client<C>()(connect('wss://test', { lazy: true, idleTimeout: 1000 }), channels());
  }

  it('releases the subscribe hold when the subscribe is rejected, so the socket idle-closes', async () => {
    vi.useFakeTimers();
    const socket = lazySocket();
    const p = socket.channel('general').subscribe(); // lazy connect
    MockWebSocket.last().open();
    MockWebSocket.last().emit({
      event: '__error__',
      payload: { code: 'forbidden' },
      __wskit: { channel: 'general' },
    });
    await expect(p).rejects.toBeDefined();

    vi.advanceTimersByTime(1000);
    expect(socket.getState()).toBe('closed'); // would stay 'open' if the hold leaked
    vi.useRealTimers();
  });

  it('releases the subscribe hold when the channel is kicked, so the socket idle-closes', async () => {
    vi.useFakeTimers();
    const socket = lazySocket();
    const room = socket.channel('general');
    const p = room.subscribe();
    const ws = MockWebSocket.last();
    ws.open();
    ws.emit({
      event: '__subscribeOk__',
      payload: { source: 'client' },
      __wskit: { channel: 'general' },
    });
    await p;

    ws.emit({ event: '__kicked__', payload: { reason: 'bye' }, __wskit: { channel: 'general' } });
    vi.advanceTimersByTime(1000);
    expect(socket.getState()).toBe('closed');
    vi.useRealTimers();
  });
});
