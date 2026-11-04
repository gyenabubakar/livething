import { WIRE_LIMITS } from '@livething/core';
import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { channels } from '~/primitives/channels/index.ts';
import { clientRequests } from '~/primitives/client-requests/index.ts';
import { reconnection } from '~/primitives/reconnection/index.ts';
import { stream } from '~/primitives/stream/index.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Primitive, ValidatePrimitives } from '~/primitives/types.ts';

interface C {
  channels: {
    general: {
      incoming: { message: { text: string }; typing: { who: string }; feed: { token: string } };
      outgoing: { 'send-message': { text: string } };
      clientRequests: { history: { payload: { before: string }; response: { items: string[] } } };
    };
    rooms: {
      addressing: 'dynamic';
      incoming: { message: { text: string } };
      outgoing: { 'send-message': { text: string } };
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
      payload: null,
      metadata: { channel: { name: 'general' } },
    });
    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      metadata: { exchange: { source: 'client' }, channel: { name: 'general' } },
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

  it('tags sends with metadata.channel once active', async () => {
    const { socket, ws } = build(channels());
    const room = socket.channel('general');
    const p = room.subscribe();
    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      metadata: { exchange: { source: 'client' }, channel: { name: 'general' } },
    });
    await p;

    room.send('send-message', { text: 'hi' });
    expect(ws.sentFrames().at(-1)).toEqual({
      event: 'send-message',
      payload: { text: 'hi' },
      metadata: { channel: { name: 'general' } },
    });
  });

  it('unsubscribe sends __unsubscribe__ and fires onUnsubscribed', async () => {
    const { socket, ws } = build(channels());
    const room = socket.channel('general');
    const p = room.subscribe();
    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      metadata: { exchange: { source: 'client' }, channel: { name: 'general' } },
    });
    await p;

    const onUnsub = vi.fn();
    room.onUnsubscribed(onUnsub);
    const leave = room.unsubscribe();
    const frame = ws.sentFrames().at(-1);
    expect(frame).toMatchObject({
      event: '__unsubscribe__',
      payload: {},
      metadata: { channel: { name: 'general' } },
    });

    const unsubscribeId = frame.metadata.channel?.unsubscribeId;
    expect(typeof unsubscribeId).toBe('string');
    expect(onUnsub).toHaveBeenCalled();
    ws.emit({
      event: '__unsubscribeOk__',
      payload: {},
      metadata: { channel: { name: 'general', unsubscribeId: unsubscribeId } },
    });
    await expect(leave).resolves.toBeUndefined();
  });

  it('rejects a pending subscribe with Disconnected on disconnect', async () => {
    const { socket } = build(channels());
    const promise = socket.channel('general').subscribe();
    socket.disconnect();
    await expect(promise).rejects.toMatchObject({ code: 'disconnected' });
  });

  it('requires a new subscribe after an intentional disconnect', async () => {
    const { socket, ws } = build(channels());
    const room = socket.channel('general');
    const onUnsubscribed = vi.fn();
    room.onUnsubscribed(onUnsubscribed);
    const first = room.subscribe();

    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      metadata: { exchange: { source: 'client' }, channel: { name: 'general' } },
    });
    await first;

    socket.disconnect();
    expect(onUnsubscribed).toHaveBeenCalledTimes(1);
    expect(() => room.send('send-message', { text: 'too early' })).toThrow(
      /channel-not-subscribed/,
    );
    socket.connect();
    const reopened = MockWebSocket.last();

    reopened.open();

    expect(reopened.sentFrames().filter((frame) => frame.event === '__subscribe__')).toEqual([]);
    const second = room.subscribe();
    expect(reopened.sentFrames().at(-1)).toEqual({
      event: '__subscribe__',
      payload: null,
      metadata: { channel: { name: 'general' } },
    });
    reopened.emit({
      event: '__subscribeOk__',
      payload: {},
      metadata: { exchange: { source: 'client' }, channel: { name: 'general' } },
    });
    await expect(second).resolves.toBeUndefined();
  });

  it('reuses the in-flight promise for an overlapping subscribe (no orphan, one frame)', async () => {
    const { socket, ws } = build(channels());
    const room = socket.channel('general');

    const first = room.subscribe();
    const second = room.subscribe();

    // Same in-flight promise — not a second, orphaned one.
    expect(second).toBe(first);
    expect(ws.sentFrames().filter((f) => f.event === '__subscribe__')).toHaveLength(1);

    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      metadata: { exchange: { source: 'client' }, channel: { name: 'general' } },
    });

    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
  });

  it('subscribe again after an unsubscribe interrupted an in-flight subscribe starts fresh', async () => {
    const { socket, ws } = build(channels());
    const room = socket.channel('general');

    room.subscribe();
    room.unsubscribe();

    function countSubscribeFrames() {
      return ws.sentFrames().filter((f) => f.event === '__subscribe__').length;
    }

    const before = countSubscribeFrames();

    // The re-subscribe is queued behind the pending leave — it must wait for the
    // leave's confirmation so it lands after the leave on the wire, never reusing
    // the dead attempt.
    const retry = room.subscribe();
    expect(countSubscribeFrames()).toBe(before);

    const unsubscribeId = ws
      .sentFrames()
      .filter((f) => f.event === '__unsubscribe__')
      .at(-1).metadata.channel?.unsubscribeId;
    ws.emit({
      event: '__unsubscribeOk__',
      payload: {},
      metadata: { channel: { name: 'general', unsubscribeId: unsubscribeId } },
    });
    expect(countSubscribeFrames()).toBe(before + 1);

    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      metadata: { exchange: { source: 'client' }, channel: { name: 'general' } },
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
      payload: {},
      metadata: { exchange: { source: 'client' }, channel: { name: 'general' } },
    });
    await p;
    ws.emit({
      event: 'message',
      payload: { text: 'hi' },
      metadata: { channel: { name: 'general' } },
    });
    expect(handler).toHaveBeenCalledWith({ text: 'hi' });
  });

  it('lets listeners register before the channel is active', async () => {
    const { socket, ws } = build(channels());
    const room = socket.channel('general');
    const handler = vi.fn();
    room.on('message', handler);
    const p = room.subscribe();

    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      metadata: { exchange: { source: 'client' }, channel: { name: 'general' } },
    });
    await p;
    ws.emit({
      event: 'message',
      payload: { text: 'late' },
      metadata: { channel: { name: 'general' } },
    });
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
      payload: {},
      metadata: { exchange: { source: 'client' }, channel: { name: 'general' } },
    });
    await p;
    ws.emit({
      event: 'feed',
      payload: { token: 'a' },
      metadata: { channel: { name: 'general' }, stream: { id: 's1', seq: 1 } },
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
      payload: {},
      metadata: { exchange: { source: 'client' }, channel: { name: 'general' } },
    });
    await p;
    ws.emit({
      event: '__memberSync__',
      payload: { members: [{ memberId: 'c1', meta: { name: 'Ada' }, online: true }] },
      metadata: { channel: { name: 'general' } },
    });

    const ada = { meta: { name: 'Ada' }, online: true };
    expect(room.members.get().get('c1')).toEqual(ada);
    expect(onJoin).toHaveBeenCalledWith('c1', ada);
    expect(onOnline).toHaveBeenCalledWith('c1', ada);
  });

  it('tracks incremental join and leave', async () => {
    const { socket, ws } = build(channels());
    const room = socket.channel('general');
    const onLeave = vi.fn();
    room.onMemberLeave(onLeave);
    const p = room.subscribe();

    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      metadata: { exchange: { source: 'client' }, channel: { name: 'general' } },
    });
    await p;
    ws.emit({
      event: '__memberJoin__',
      payload: { memberId: 'c2' },
      metadata: { channel: { name: 'general' } },
    });
    expect(room.members.get().has('c2')).toBe(true);
    ws.emit({
      event: '__memberLeave__',
      payload: { memberId: 'c2' },
      metadata: { channel: { name: 'general' } },
    });

    expect(room.members.get().has('c2')).toBe(false);
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
      payload: {},
      metadata: { exchange: { source: 'client' }, channel: { name: 'general' } },
    });
    await p;
    ws.emit({
      event: '__kicked__',
      payload: { reason: 'spam' },
      metadata: { channel: { name: 'general' } },
    });
    expect(onKicked).toHaveBeenCalledWith('spam');
    expect(() => room.send('send-message', { text: 'x' })).toThrow(/channel-not-subscribed/);
  });
});

describe('dynamic families and scope handles', () => {
  it('tags dynamic channels with channel + channelFamily', async () => {
    const { socket, ws } = build(channels());
    const room = socket.channel('rooms', 'room-1');
    const p = room.subscribe();
    expect(ws.sentFrames().at(-1)).toEqual({
      event: '__subscribe__',
      payload: null,
      metadata: { channel: { name: 'room-1', family: 'rooms' } },
    });
    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      metadata: { exchange: { source: 'client' }, channel: { name: 'room-1', family: 'rooms' } },
    });

    await p;
    room.send('send-message', { text: 'hi' });
    expect(ws.sentFrames().at(-1).metadata).toEqual({
      channel: { name: 'room-1', family: 'rooms' },
    });
  });

  it('resolves the same handle via channel(scope,name) and scope(key)(name)', () => {
    const { socket } = build(channels());
    expect(socket.channel('rooms', 'room-1')).toBe(socket.channel.family('rooms')('room-1'));
  });

  it('an absent scope subscribes as a static channel (no channelFamily marker)', async () => {
    const { socket, ws } = build(channels());
    const room = socket.channel('general');
    void room.subscribe();
    expect(ws.sentFrames().at(-1).metadata).toEqual({ channel: { name: 'general' } });
  });

  it('a supplied family key is carried in the channelFamily marker', () => {
    const { socket, ws } = build(channels());
    const room = socket.channel('rooms', 'room-9');
    void room.subscribe();
    expect(ws.sentFrames().at(-1).metadata).toEqual({
      channel: { name: 'room-9', family: 'rooms' },
    });
  });

  it('rejects an empty family key locally with validation-failed and sends nothing', async () => {
    const { socket, ws } = build(channels());
    const room = socket.channel('rooms', '');
    const before = ws.sentFrames().length;
    await expect(room.subscribe()).rejects.toMatchObject({ code: 'validation-failed' });
    expect(ws.sentFrames().length).toBe(before);
  });

  it('family-level on() fires with the channel name', async () => {
    const { socket, ws } = build(channels());
    const family = socket.channel.family('rooms');
    const familyHandler = vi.fn();
    family.on('message', familyHandler);
    const room = family('room-7');

    const p = room.subscribe();
    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      metadata: { exchange: { source: 'client' }, channel: { name: 'room-7', family: 'rooms' } },
    });
    await p;
    ws.emit({
      event: 'message',
      payload: { text: 'yo' },
      metadata: { channel: { name: 'room-7', family: 'rooms' } },
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
      payload: {},
      metadata: { exchange: { source: 'server' }, channel: { name: 'general' } },
    });
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
        payload: {},
        metadata: { exchange: { source: 'client' }, channel: { name: 'general' } },
      });
      first.serverClose(1006, 'drop');
      vi.advanceTimersByTime(1500);
      const second = MockWebSocket.last();
      second.open();

      expect(second.sentFrames()).toContainEqual({
        event: '__subscribe__',
        payload: null,
        metadata: { channel: { name: 'general' } },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a stale server auto-rejoin confirmation after an intentional leave during reconnect', () => {
    vi.useFakeTimers();
    try {
      const socket = client<C>()(connect('wss://test'), channels(), reconnection());
      socket.connect();
      const first = MockWebSocket.last();
      first.open();
      const room = socket.channel('general');

      room.subscribe();
      first.emit({
        event: '__subscribeOk__',
        payload: {},
        metadata: {
          exchange: { source: 'client' },
          channel: { name: 'general', membership: 'persistent' },
        },
      });

      first.serverClose(1006, 'drop');
      room.unsubscribe();

      vi.advanceTimersByTime(1500);
      const second = MockWebSocket.last();
      second.open();
      const leaveFrame = second.sentFrames().find((f) => f.event === '__unsubscribe__');
      expect(leaveFrame).toMatchObject({ payload: {}, metadata: { channel: { name: 'general' } } });

      expect(typeof leaveFrame.metadata.channel?.unsubscribeId).toBe('string');

      // The server's already-queued auto-rejoin __subscribeOk__ arrives late — it
      // must NOT re-activate a channel the user left (the server already removed it).
      second.emit({
        event: '__subscribeOk__',
        payload: {},
        metadata: {
          exchange: { source: 'server' },
          channel: { name: 'general', membership: 'persistent' },
        },
      });

      expect(() => room.send('send-message', { text: 'hi' })).toThrow();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('reliable leave', () => {
  function leaveId(ws: MockWebSocket): string {
    return ws
      .sentFrames()
      .filter((f) => f.event === '__unsubscribe__')
      .at(-1).metadata.channel?.unsubscribeId;
  }

  it('resends the leave on every reopen until the server confirms it', async () => {
    vi.useFakeTimers();
    try {
      const socket = client<C>()(connect('wss://test'), channels(), reconnection());
      socket.connect();
      const first = MockWebSocket.last();
      first.open();
      const room = socket.channel('general');

      room.subscribe();
      first.emit({
        event: '__subscribeOk__',
        payload: {},
        metadata: {
          exchange: { source: 'client' },
          channel: { name: 'general', membership: 'persistent' },
        },
      });

      const leave = room.unsubscribe();
      const id = leaveId(first);

      first.serverClose(1006, 'drop');
      vi.advanceTimersByTime(1500);
      const second = MockWebSocket.last();
      second.open();
      expect(
        second
          .sentFrames()
          .some((f) => f.event === '__unsubscribe__' && f.metadata.channel?.unsubscribeId === id),
      ).toBe(true);

      second.serverClose(1006, 'drop');
      vi.advanceTimersByTime(3000);
      const third = MockWebSocket.last();
      third.open();
      expect(
        third
          .sentFrames()
          .some((f) => f.event === '__unsubscribe__' && f.metadata.channel?.unsubscribeId === id),
      ).toBe(true);

      expect(
        third
          .sentFrames()
          .some((f) => f.event === '__subscribe__' && f.metadata?.channel?.name === 'general'),
      ).toBe(false);

      third.emit({
        event: '__unsubscribeOk__',
        payload: {},
        metadata: { channel: { name: 'general', unsubscribeId: id } },
      });
      await expect(leave).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects the leave promise when reconnection is permanently abandoned', async () => {
    vi.useFakeTimers();
    try {
      const socket = client<C>()(
        connect('wss://test'),
        channels(),
        reconnection({ maxAttempts: 1 }),
      );
      socket.connect();
      const first = MockWebSocket.last();
      first.open();
      const room = socket.channel('general');

      room.subscribe();
      first.emit({
        event: '__subscribeOk__',
        payload: {},
        metadata: {
          exchange: { source: 'client' },
          channel: { name: 'general', membership: 'persistent' },
        },
      });

      const leave = room.unsubscribe();
      first.serverClose(1006, 'drop');
      vi.advanceTimersByTime(60_000);
      MockWebSocket.last().serverClose(1006, 'still down');

      await expect(leave).rejects.toMatchObject({ code: 'disconnected' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a confirmation with a mismatched id, then settles on the matching one', async () => {
    const { socket, ws } = build(channels());
    const room = socket.channel('general');
    const stale = vi.fn();
    (socket as unknown as { on(event: string, handler: () => void): void }).on(
      '__unsubscribeOk__',
      stale,
    );
    const p = room.subscribe();

    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      metadata: { exchange: { source: 'client' }, channel: { name: 'general' } },
    });
    await p;

    const leave = room.unsubscribe();
    const id = leaveId(ws);

    let settled = false;
    void leave.then(() => {
      settled = true;
    });
    // A confirmation for a different id (a stale one) must not settle this leave.
    ws.emit({
      event: '__unsubscribeOk__',
      payload: {},
      metadata: { channel: { name: 'general', unsubscribeId: 'stale-id' } },
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(stale).not.toHaveBeenCalled();

    ws.emit({
      event: '__unsubscribeOk__',
      payload: {},
      metadata: { channel: { name: 'general', unsubscribeId: id } },
    });
    await expect(leave).resolves.toBeUndefined();
    ws.emit({
      event: '__unsubscribeOk__',
      payload: {},
      metadata: { channel: { name: 'general', unsubscribeId: id } },
    });
  });

  it('shares one promise while a leave is pending and resolves immediately when already left', async () => {
    const { socket, ws } = build(channels());
    const room = socket.channel('general');
    const p = room.subscribe();
    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      metadata: { exchange: { source: 'client' }, channel: { name: 'general' } },
    });
    await p;

    const leave1 = room.unsubscribe();
    const leave2 = room.unsubscribe();
    expect(leave2).toBe(leave1);
    expect(ws.sentFrames().filter((f) => f.event === '__unsubscribe__')).toHaveLength(1);

    const id = leaveId(ws);
    ws.emit({
      event: '__unsubscribeOk__',
      payload: {},
      metadata: { channel: { name: 'general', unsubscribeId: id } },
    });
    await expect(leave1).resolves.toBeUndefined();

    await expect(room.unsubscribe()).resolves.toBeUndefined();
    expect(ws.sentFrames().filter((f) => f.event === '__unsubscribe__')).toHaveLength(1);
  });

  it('ignores a late client subscribe ack that overlapped the leave', async () => {
    const { socket, ws } = build(channels());
    const room = socket.channel('general');

    room.subscribe();
    const leave = room.unsubscribe();

    // The server's confirmation for the earlier subscribe lands late, while the
    // leave is still pending. It must NOT re-activate the channel.
    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      metadata: { exchange: { source: 'client' }, channel: { name: 'general' } },
    });
    expect(() => room.send('send-message', { text: 'x' })).toThrow(/channel-not-subscribed/);

    const id = leaveId(ws);
    ws.emit({
      event: '__unsubscribeOk__',
      payload: {},
      metadata: { channel: { name: 'general', unsubscribeId: id } },
    });
    await expect(leave).resolves.toBeUndefined();
    expect(() => room.send('send-message', { text: 'x' })).toThrow(/channel-not-subscribed/);
  });

  it('keeps a re-subscribe queued behind a leave alive across a transient drop', async () => {
    vi.useFakeTimers();
    try {
      const socket = client<C>()(connect('wss://test'), channels(), reconnection());
      socket.connect();
      const first = MockWebSocket.last();
      first.open();
      const room = socket.channel('general');

      room.subscribe();
      first.emit({
        event: '__subscribeOk__',
        payload: {},
        metadata: { exchange: { source: 'client' }, channel: { name: 'general' } },
      });

      const leave = room.unsubscribe();
      const rejoin = room.subscribe();
      void leave.then(undefined, () => undefined);
      void rejoin.then(undefined, () => undefined);

      first.serverClose(1006, 'drop');
      vi.advanceTimersByTime(1500);
      const second = MockWebSocket.last();
      second.open();

      const id = second
        .sentFrames()
        .filter((f) => f.event === '__unsubscribe__')
        .at(-1).metadata.channel?.unsubscribeId;
      second.emit({
        event: '__unsubscribeOk__',
        payload: {},
        metadata: { channel: { name: 'general', unsubscribeId: id } },
      });
      expect(
        second
          .sentFrames()
          .some((f) => f.event === '__subscribe__' && f.metadata?.channel?.name === 'general'),
      ).toBe(true);
      second.emit({
        event: '__subscribeOk__',
        payload: {},
        metadata: { exchange: { source: 'client' }, channel: { name: 'general' } },
      });

      await expect(leave).resolves.toBeUndefined();
      await expect(rejoin).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-runs a function payload for a re-subscribe queued behind a leave', async () => {
    const { socket, ws } = build(channels());
    const room = socket.channel('general');
    room.subscribe();
    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      metadata: { exchange: { source: 'client' }, channel: { name: 'general' } },
    });

    const leave = room.unsubscribe();
    void leave.then(undefined, () => undefined);

    // Queue a rejoin with a function payload (a rotating token). It must not be
    // evaluated until the leave confirms — and then run fresh.
    let calls = 0;
    const rejoin = room.subscribe(() => {
      calls += 1;
      return { token: `t${calls}` };
    });
    void rejoin.then(undefined, () => undefined);
    expect(calls).toBe(0);

    const id = leaveId(ws);
    ws.emit({
      event: '__unsubscribeOk__',
      payload: {},
      metadata: { channel: { name: 'general', unsubscribeId: id } },
    });

    expect(calls).toBe(1);
    await Promise.resolve();
    await Promise.resolve();
    const sub = ws
      .sentFrames()
      .filter((f) => f.event === '__subscribe__')
      .at(-1);
    expect(sub.payload).toEqual({ token: 't1' });
  });
});

describe('scoped request and ack', () => {
  it('channel request tags the channel and resolves', async () => {
    const { socket, ws } = build(channels(), clientRequests());
    const room = socket.channel('general') as ReturnType<(typeof socket)['channel']> & {
      request(event: string, payload: unknown): Promise<unknown>;
    };
    const p = room.subscribe();
    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      metadata: { exchange: { source: 'client' }, channel: { name: 'general' } },
    });
    await p;

    const reqPromise = room.request('history', { before: 'x' });
    const frame = ws.sentFrames().at(-1);
    expect(frame.metadata.channel?.name).toBe('general');
    expect(typeof frame.metadata.exchange?.id).toBe('string');
    ws.emit({
      event: 'history',
      payload: { items: ['a'] },
      metadata: { exchange: { id: frame.metadata.exchange?.id } },
    });

    await expect(reqPromise).resolves.toEqual({ items: ['a'] });
  });

  it('channel request is guarded before subscribe', () => {
    const { socket } = build(channels(), clientRequests());
    const room = socket.channel('general') as ReturnType<(typeof socket)['channel']> & {
      request(event: string, payload: unknown): Promise<unknown>;
    };
    expect(() => room.request('history', { before: 'x' })).toThrow(/channel-not-subscribed/);
  });
});

describe('stream-error routing (order-independent)', () => {
  it('routes a channel-scoped stream error to the stream primitive, not to channel subscribe-failure, even when channels is registered first', async () => {
    const { socket, ws } = build(channels(), stream());
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
      payload: {},
      metadata: { exchange: { source: 'client' }, channel: { name: 'general' } },
    });

    await p;

    const onSubFailed = vi.fn();
    room.onSubscriptionFailed(onSubFailed);

    const onChunk = vi.fn();
    const onError = vi.fn();
    room.onStream('ask-ai', { onChunk, onError, onEnd: vi.fn() });

    ws.emit({
      event: 'ask-ai',
      payload: { text: 'hi' },
      metadata: { channel: { name: 'general' }, stream: { id: 's1', seq: 0 } },
    });
    ws.emit({
      event: '__error__',
      payload: { code: 'internal-error' },
      metadata: { channel: { name: 'general' }, stream: { id: 's1', terminated: true } },
    });

    expect(onChunk).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onSubFailed).not.toHaveBeenCalled();
  });
});

describe('lazy hold lifecycle (no leak)', () => {
  function lazySocket() {
    return client<C>()(connect('wss://test', { lazy: true, idleTimeout: 1000 }), channels());
  }

  it('releases the subscribe hold when the subscribe is rejected, so the socket idle-closes', async () => {
    vi.useFakeTimers();
    const socket = lazySocket();
    const p = socket.channel('general').subscribe();
    MockWebSocket.last().open();
    MockWebSocket.last().emit({
      event: '__error__',
      payload: { code: 'forbidden' },
      metadata: { channel: { name: 'general' } },
    });

    await expect(p).rejects.toBeDefined();

    vi.advanceTimersByTime(1000);
    expect(socket.state.get()).toBe('closed');
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
      payload: {},
      metadata: { exchange: { source: 'client' }, channel: { name: 'general' } },
    });
    await p;

    ws.emit({
      event: '__kicked__',
      payload: { reason: 'bye' },
      metadata: { channel: { name: 'general' } },
    });
    vi.advanceTimersByTime(1000);
    expect(socket.state.get()).toBe('closed');
    vi.useRealTimers();
  });
});

describe('subscribe wire-limit validation', () => {
  it('rejects an over-limit channel name without holding the socket open', async () => {
    const { socket, ws } = build(channels());
    const before = ws.sentFrames().length;
    const tooLong = 'x'.repeat(WIRE_LIMITS.channel + 1);
    const room = socket.channel('rooms', tooLong);

    await expect(room.subscribe()).rejects.toMatchObject({ code: 'validation-failed' });

    expect((socket as unknown as { _lazyConsumers: number })._lazyConsumers).toBe(0);
    expect(ws.sentFrames().length).toBe(before);
  });

  it('accepts a channel name exactly at the limit', () => {
    const { socket, ws } = build(channels());
    const atLimit = 'x'.repeat(WIRE_LIMITS.channel);
    const room = socket.channel('rooms', atLimit);
    void room.subscribe().catch(() => undefined);
    expect(ws.sentFrames().at(-1)).toMatchObject({ event: '__subscribe__' });
  });

  it('rejects an empty channel name with validation-failed', async () => {
    const { socket } = build(channels());
    const room = socket.channel('rooms', '');
    await expect(room.subscribe()).rejects.toMatchObject({ code: 'validation-failed' });
  });
});

describe('subscribe before connect', () => {
  it('rejects with Disconnected on a closed non-lazy socket', async () => {
    // Built but never connected: state is 'closed' and non-lazy, so the frame
    // can't go out and no flush is coming. It must fail fast, not hang.
    const socket = client<C>()(connect('wss://test'), channels());
    await expect(socket.channel('general').subscribe()).rejects.toMatchObject({
      code: 'disconnected',
    });
  });
});

describe('subscribe setup failure cleanup', () => {
  it('rejects and releases the lazy hold when the payload factory throws synchronously', async () => {
    const { socket } = build(channels());
    const room = socket.channel('general');

    await expect(
      room.subscribe(() => {
        throw new Error('factory boom');
      }),
    ).rejects.toThrow('factory boom');

    expect((socket as unknown as { _lazyConsumers: number })._lazyConsumers).toBe(0);
  });
});

describe('stale payload rejection guard', () => {
  it('a stale payload rejection does not reject a newer subscribe', async () => {
    const { socket, ws } = build(channels());
    const room = socket.channel('general');

    let rejectFirst!: (error: unknown) => void;
    const firstPayload = new Promise<unknown>((_, reject) => {
      rejectFirst = reject;
    });
    const first = room.subscribe(() => firstPayload);
    void first.catch(() => undefined);

    room.unsubscribe();
    const second = room.subscribe({ token: 'fresh' });

    // The first payload now rejects late — it must not touch the newer subscribe.
    rejectFirst(new Error('stale'));
    await Promise.resolve();
    await Promise.resolve();

    const unsubscribeId = ws
      .sentFrames()
      .filter((f) => f.event === '__unsubscribe__')
      .at(-1).metadata.channel?.unsubscribeId;
    ws.emit({
      event: '__unsubscribeOk__',
      payload: {},
      metadata: { channel: { name: 'general', unsubscribeId: unsubscribeId } },
    });
    ws.emit({ event: '__subscribeOk__', payload: {}, metadata: { channel: { name: 'general' } } });
    await expect(second).resolves.toBeUndefined();
  });
});

interface PluginChannelC {
  channels: {
    '__e2e:feed::room': {
      incoming: { joined: { who: string } };
    };
  };
}

// A plugin owns its `__id::` channels, so they are not on the top-level typed
// socket. The channels primitive still routes them at runtime, so these tests
// reach the channel by name the way a plugin's scoped socket does.
type PluginRoomHandle = {
  on(event: 'joined', handler: (data: { who: string }) => void): () => void;
  subscribe(): Promise<void>;
};
type ChannelByName = (name: string) => PluginRoomHandle;

describe('plugin-channel namespace delivery (A3)', () => {
  function buildPlugin() {
    const socket = client<PluginChannelC>()(connect('wss://test'), channels());
    socket.connect();
    const ws = MockWebSocket.last();
    ws.open();

    return { socket, ws };
  }

  it("delivers a plugin channel's __id::-prefixed event under its bare contract name", async () => {
    const { socket, ws } = buildPlugin();
    const room = (socket.channel as unknown as ChannelByName)('__e2e:feed::room');
    const seen: { who: string }[] = [];
    room.on('joined', (data) => seen.push(data));

    const p = room.subscribe();
    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      metadata: { exchange: { source: 'client' }, channel: { name: '__e2e:feed::room' } },
    });
    await p;

    ws.emit({
      event: '__e2e:feed::joined',
      payload: { who: 'alice' },
      metadata: { exchange: { source: 'server' }, channel: { name: '__e2e:feed::room' } },
    });
    expect(seen).toEqual([{ who: 'alice' }]);
  });

  it("only strips the channel's own prefix — a foreign-prefixed event is not delivered as the bare name", async () => {
    const { socket, ws } = buildPlugin();
    const room = (socket.channel as unknown as ChannelByName)('__e2e:feed::room');
    const joined = vi.fn();
    room.on('joined', joined);

    const p = room.subscribe();
    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      metadata: { exchange: { source: 'client' }, channel: { name: '__e2e:feed::room' } },
    });
    await p;

    ws.emit({
      event: '__other:plugin::joined',
      payload: { who: 'x' },
      metadata: { exchange: { source: 'server' }, channel: { name: '__e2e:feed::room' } },
    });
    expect(joined).not.toHaveBeenCalled();
  });
});

describe('protocol frame forwarding stays channel-scoped', () => {
  it('settles subscribe state yet never delivers __subscribeOk__ to a top-level handler', async () => {
    const { socket, ws } = build(channels());
    const topLevel = vi.fn();
    // A user could register the reserved name; it must never fire.
    (socket as unknown as { on(e: string, h: () => void): void }).on('__subscribeOk__', topLevel);

    const room = socket.channel('general');
    const p = room.subscribe();
    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      metadata: { exchange: { source: 'client' }, channel: { name: 'general', inbox: true } },
    });
    await expect(p).resolves.toBeUndefined();
    expect(topLevel).not.toHaveBeenCalled();
  });

  it('settles a leave on __unsubscribeOk__ without reaching a top-level handler', async () => {
    const { socket, ws } = build(channels());
    const topLevel = vi.fn();
    (socket as unknown as { on(e: string, h: () => void): void }).on('__unsubscribeOk__', topLevel);

    const room = socket.channel('general');
    const p = room.subscribe();
    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      metadata: { exchange: { source: 'client' }, channel: { name: 'general' } },
    });
    await p;

    const leave = room.unsubscribe();
    const unsubscribeId = ws.sentFrames().at(-1).metadata.channel?.unsubscribeId;
    ws.emit({
      event: '__unsubscribeOk__',
      payload: {},
      metadata: { channel: { name: 'general', unsubscribeId: unsubscribeId } },
    });
    await expect(leave).resolves.toBeUndefined();
    expect(topLevel).not.toHaveBeenCalled();
  });

  it('fires onKicked on __kicked__ without reaching a top-level handler', async () => {
    const { socket, ws } = build(channels());
    const topLevel = vi.fn();
    (socket as unknown as { on(e: string, h: () => void): void }).on('__kicked__', topLevel);

    const room = socket.channel('general');
    const p = room.subscribe();
    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      metadata: { exchange: { source: 'client' }, channel: { name: 'general' } },
    });
    await p;
    const onKicked = vi.fn();

    room.onKicked(onKicked);

    ws.emit({
      event: '__kicked__',
      payload: { reason: 'spam' },
      metadata: { channel: { name: 'general' } },
    });

    expect(onKicked).toHaveBeenCalledWith('spam');
    expect(topLevel).not.toHaveBeenCalled();
  });
});
