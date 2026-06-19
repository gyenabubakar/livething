import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { channels } from '~/primitives/channels/index.ts';
import { reconnection } from '~/primitives/reconnection/index.ts';
import { requestResponse } from '~/primitives/request-response/index.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface C {
  channels: {
    general: {
      incoming: { message: { text: string } };
      outgoing: { 'send-message': { text: string } };
      requests: Record<string, never>;
    };
    rooms: {
      addressing: 'dynamic';
      incoming: { update: { body: string } };
      outgoing: { post: { body: string } };
      requests: Record<string, never>;
    };
    lobbies: {
      addressing: 'dynamic';
      incoming: { update: { body: string } };
      outgoing: { post: { body: string } };
      requests: Record<string, never>;
    };
  };
}

function build() {
  const socket = client<C>()(connect('wss://test'), channels());
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

describe('channels-reconnect-resubscribe-failure-surfaces', () => {
  it('fires onSubscriptionFailed (not reject) when server rejects a reconnect re-subscribe', () => {
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
        __wskit: { source: 'client', channel: 'general' },
      });

      first.serverClose(1006, 'drop');

      vi.advanceTimersByTime(1500);
      const second = MockWebSocket.last();
      second.open();

      const onSubFailed = vi.fn();
      room.onSubscriptionFailed(onSubFailed);

      second.emit({
        event: '__error__',
        payload: { code: 'forbidden' },
        __wskit: { channel: 'general' },
      });

      expect(onSubFailed).toHaveBeenCalledWith(expect.objectContaining({ code: 'forbidden' }));

      expect(() => room.send('send-message', { text: 'x' })).toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears a PERSISTENT channel when the server rejects its auto-rejoin with rejoin-rejected', () => {
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
        __wskit: { source: 'client', channel: 'general', channelPersistent: true },
      });

      // Drop → reconnect. A persistent channel is auto-rejoined by the server, so
      // the client must NOT send its own __subscribe__ on reopen.
      first.serverClose(1006, 'drop');
      vi.advanceTimersByTime(1500);
      const second = MockWebSocket.last();
      second.open();

      const clientResubscribes = second
        .sentFrames()
        .filter((f) => f.event === '__subscribe__' && f.__wskit?.channel === 'general');
      expect(clientResubscribes).toHaveLength(0);

      const onSubFailed = vi.fn();
      room.onSubscriptionFailed(onSubFailed);

      second.emit({
        event: '__error__',
        payload: { code: 'rejoin-rejected' },
        __wskit: { channel: 'general' },
      });

      expect(onSubFailed).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'rejoin-rejected' }),
      );
      expect(() => room.send('send-message', { text: 'x' })).toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the channel active when a channel-scoped __error__ arrives in steady state (a message error, not a (re)subscribe)', () => {
    const socket = client<C>()(connect('wss://test'), channels(), reconnection());
    socket.connect();
    const ws = MockWebSocket.last();
    ws.open();

    const room = socket.channel('general');
    room.subscribe();
    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      __wskit: { source: 'client', channel: 'general' },
    });

    const onSubFailed = vi.fn();
    room.onSubscriptionFailed(onSubFailed);

    ws.emit({
      event: '__error__',
      payload: { code: 'validation-failed' },
      __wskit: { channel: 'general' },
    });

    expect(onSubFailed).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'validation-failed' }),
    );
    expect(() => room.send('send-message', { text: 'x' })).not.toThrow();
  });
});

describe('channels-reconnect-skips-persistent', () => {
  it('does not re-subscribe a persistent channel on reconnect; the server auto-rejoins it', () => {
    vi.useFakeTimers();
    try {
      const socket = client<C>()(connect('wss://test'), channels(), reconnection());
      socket.connect();
      const first = MockWebSocket.last();
      first.open();

      const persistent = socket.channel('general');
      const ephemeral = socket.channel('rooms', 'room:1');
      persistent.subscribe();
      ephemeral.subscribe();

      first.emit({
        event: '__subscribeOk__',
        payload: {},
        __wskit: { source: 'client', channel: 'general', channelPersistent: true },
      });
      first.emit({
        event: '__subscribeOk__',
        payload: {},
        __wskit: {
          source: 'client',
          channel: 'room:1',
          channelScope: 'rooms',
          channelPersistent: false,
        },
      });

      first.serverClose(1006, 'drop');
      vi.advanceTimersByTime(1500);
      const second = MockWebSocket.last();
      second.open();

      const resubscribes = second.sentFrames().filter((f) => f.event === '__subscribe__');
      expect(resubscribes.map((f) => f.__wskit?.channel)).toEqual(['room:1']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not refresh a function subscribe payload on reconnect for a persistent channel', async () => {
    vi.useFakeTimers();
    try {
      const socket = client<C>()(connect('wss://test'), channels(), reconnection());
      socket.connect();
      const first = MockWebSocket.last();
      first.open();

      let calls = 0;
      const room = socket.channel('general');
      void room.subscribe(() => ({ token: `tok-${++calls}` }));

      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toBe(1);
      first.emit({
        event: '__subscribeOk__',
        payload: {},
        __wskit: { source: 'client', channel: 'general', channelPersistent: true },
      });

      first.serverClose(1006, 'drop');
      await vi.advanceTimersByTimeAsync(1500);
      const second = MockWebSocket.last();
      second.open();
      await vi.advanceTimersByTimeAsync(0);

      expect(calls).toBe(1);
      expect(second.sentFrames().some((f) => f.event === '__subscribe__')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('channels-reconnect-rejoin-before-queued-ops', () => {
  it('rejoins a channel before flushing a request queued during the reconnect', () => {
    vi.useFakeTimers();
    try {
      const socket = client<C>()(
        connect('wss://test'),
        channels(),
        requestResponse(),
        reconnection(),
      );
      socket.connect();
      const first = MockWebSocket.last();
      first.open();

      const room = socket.channel('general');
      room.subscribe();
      first.emit({
        event: '__subscribeOk__',
        payload: {},
        __wskit: { source: 'client', channel: 'general' },
      });

      first.serverClose(1006, 'drop');
      void (room as unknown as { request(e: string, p: unknown): Promise<unknown> })
        .request('history', { before: 'x' })
        .catch(() => undefined);

      // Reconnect: the rejoin __subscribe__ must reach the server BEFORE the queued
      // request, or the server would answer ChannelNotSubscribed.
      vi.advanceTimersByTime(1500);
      const second = MockWebSocket.last();
      second.open();

      const events = second.sentFrames().map((f) => f.event);
      const subIdx = events.indexOf('__subscribe__');
      const reqIdx = events.indexOf('history');
      expect(subIdx).toBeGreaterThanOrEqual(0);
      expect(reqIdx).toBeGreaterThanOrEqual(0);
      expect(subIdx).toBeLessThan(reqIdx);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('channels-unsubscribe-during-reconnect-wins-over-rejoin', () => {
  it('does not rejoin a persistent channel that was unsubscribed while reconnecting', () => {
    vi.useFakeTimers();
    try {
      const socket = client<C>()(connect('wss://test'), channels(), reconnection());
      socket.connect();
      const first = MockWebSocket.last();
      first.open();

      const room = socket.channel('general');
      const unsubscribed = vi.fn();
      room.onUnsubscribed(unsubscribed);
      room.subscribe();
      first.emit({
        event: '__subscribeOk__',
        payload: {},
        __wskit: { source: 'client', channel: 'general', channelPersistent: true },
      });

      first.serverClose(1006, 'drop');

      room.unsubscribe();
      expect(unsubscribed).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(1500);
      const second = MockWebSocket.last();
      second.open();

      const sent = second.sentFrames();
      expect(
        sent.some((f) => f.event === '__unsubscribe__' && f.__wskit?.channel === 'general'),
      ).toBe(true);
      expect(
        sent.some((f) => f.event === '__subscribe__' && f.__wskit?.channel === 'general'),
      ).toBe(false);
      expect(unsubscribed).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('channels-reconnect-refreshes-function-subscribe-payload', () => {
  it('re-invokes a function subscribe payload on reconnect, sending a fresh value', async () => {
    vi.useFakeTimers();
    try {
      const socket = client<C>()(connect('wss://test'), channels(), reconnection());
      socket.connect();
      const first = MockWebSocket.last();
      first.open();

      let calls = 0;
      const room = socket.channel('general');
      void room.subscribe(() => ({ token: `tok-${++calls}` }));

      await vi.advanceTimersByTimeAsync(0);
      expect(first.sentFrames().find((f) => f.event === '__subscribe__')?.payload).toEqual({
        token: 'tok-1',
      });
      first.emit({
        event: '__subscribeOk__',
        payload: {},
        __wskit: { source: 'client', channel: 'general' },
      });

      first.serverClose(1006, 'drop');
      await vi.advanceTimersByTimeAsync(1500);
      const second = MockWebSocket.last();
      second.open();
      await vi.advanceTimersByTimeAsync(0);

      expect(second.sentFrames().find((f) => f.event === '__subscribe__')?.payload).toEqual({
        token: 'tok-2',
      });
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('channels-reconnect-payload-refresh-failure-reaches-onError (#22)', () => {
  it('reports a throwing subscribe payload refresh via onError', async () => {
    vi.useFakeTimers();
    try {
      const socket = client<C>()(connect('wss://test'), channels(), reconnection());
      socket.connect();
      const first = MockWebSocket.last();
      first.open();

      const errors: unknown[] = [];
      socket.onError((error) => errors.push(error));

      let calls = 0;
      const room = socket.channel('general');
      void room.subscribe(() => {
        calls++;
        if (calls > 1) throw new Error('token refresh boom');
        return {};
      });

      await vi.advanceTimersByTimeAsync(0);
      first.emit({
        event: '__subscribeOk__',
        payload: {},
        __wskit: { source: 'client', channel: 'general' },
      });

      first.serverClose(1006, 'drop');
      await vi.advanceTimersByTimeAsync(1500);
      MockWebSocket.last().open();
      await vi.advanceTimersByTimeAsync(0);

      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toBe('token refresh boom');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('channels-onclose-keeps-active-clears-members', () => {
  it('clears members on drop but keeps state.active so send() does not throw', async () => {
    const { socket, ws } = build();
    const room = socket.channel('general');
    const subscribePromise = room.subscribe();
    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      __wskit: { source: 'client', channel: 'general' },
    });
    await subscribePromise;

    ws.emit({
      event: '__memberSync__',
      payload: { members: [{ connectionId: 'c1', meta: { name: 'Ada' } }] },
      __wskit: { channel: 'general' },
    });
    expect(room.members.size).toBe(1);

    ws.serverClose(1006, 'drop');

    expect(room.members.size).toBe(0);

    // Channel is still "active" — send() must not throw channel-not-subscribed.
    expect(() => room.send('send-message', { text: 'ok' })).not.toThrow();
  });
});

describe('channels-server-subscribe-and-kick-family-notify', () => {
  it('scoped __subscribeOk__ fires family onSubscribed with source and channel name', () => {
    const { socket, ws } = build();
    const family = socket.channel.scope('rooms');

    const onFamilySubscribed = vi.fn();
    family.onSubscribed(onFamilySubscribed);

    family('room-42').subscribe();

    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      __wskit: { source: 'server', channel: 'room-42', channelScope: 'rooms' },
    });

    expect(onFamilySubscribed).toHaveBeenCalledWith('room-42', 'server');
  });

  it('scoped __kicked__ fires family onUnsubscribed and drops channel from list()', async () => {
    const { socket, ws } = build();
    const family = socket.channel.scope('rooms');

    const onFamilyUnsubscribed = vi.fn();
    family.onUnsubscribed(onFamilyUnsubscribed);

    const room = family('room-42');
    const subscribePromise = room.subscribe();

    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      __wskit: { source: 'client', channel: 'room-42', channelScope: 'rooms' },
    });
    await subscribePromise;

    expect(family.list()).toEqual(['room-42']);

    ws.emit({
      event: '__kicked__',
      payload: { reason: 'banned' },
      __wskit: { channel: 'room-42', channelScope: 'rooms' },
    });

    expect(onFamilyUnsubscribed).toHaveBeenCalledWith('room-42');
    expect(family.list()).toEqual([]);
  });
});

describe('channel-subscribeok-server-leaves-pending-hanging', () => {
  it('resolves subscribe() and activates the channel when the confirmation is source=server', async () => {
    const { socket, ws } = build();
    const room = socket.channel('general');

    let resolved = false;
    const subscribePromise = room.subscribe().then(() => {
      resolved = true;
    });

    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      __wskit: { source: 'server', channel: 'general' },
    });

    await subscribePromise;
    expect(resolved).toBe(true);
    expect(() => room.send('send-message', { text: 'ok' })).not.toThrow();
  });
});

describe('channel-unsubscribe-while-inactive-is-a-no-op', () => {
  it('unsubscribe() on a never-subscribed channel sends nothing and fires no onUnsubscribed', () => {
    const { socket, ws } = build();
    const room = socket.channel('general');

    const onUnsub = vi.fn();
    room.onUnsubscribed(onUnsub);

    const before = ws.sentFrames().length;
    // Never called subscribe() — channel is inactive and has no pending subscribe.
    room.unsubscribe();

    expect(ws.sentFrames()).toHaveLength(before);
    expect(ws.sentFrames().some((f) => f.event === '__unsubscribe__')).toBe(false);
    expect(onUnsub).not.toHaveBeenCalled();
  });

  it('unsubscribe() still works on an active channel', () => {
    const { socket, ws } = build();
    const room = socket.channel('general');
    room.subscribe();
    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      __wskit: { source: 'client', channel: 'general' },
    });

    const onUnsub = vi.fn();
    room.onUnsubscribed(onUnsub);
    room.unsubscribe();

    const leaveFrame = ws.sentFrames().find((f) => f.event === '__unsubscribe__');
    expect(leaveFrame).toMatchObject({ payload: {}, __wskit: { channel: 'general' } });
    expect(typeof leaveFrame.__wskit.unsubscribeId).toBe('string');
    expect(onUnsub).toHaveBeenCalled();
  });
});

describe('scope-handle-list-only-active', () => {
  it('excludes a channel whose subscribe is still pending (not yet confirmed)', async () => {
    const { socket, ws } = build();
    const family = socket.channel.scope('rooms');
    family('room-pending').subscribe();

    expect(ws.sentFrames().some((f) => f.event === '__subscribeOk__')).toBe(false);

    expect(family.list()).toEqual([]);
  });

  it('excludes a channel that was unsubscribed / kicked after being active', async () => {
    const { socket, ws } = build();
    const family = socket.channel.scope('rooms');

    const room = family('room-x');
    const subscribePromise = room.subscribe();
    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      __wskit: { source: 'client', channel: 'room-x', channelScope: 'rooms' },
    });
    await subscribePromise;

    expect(family.list()).toEqual(['room-x']);

    room.unsubscribe();
    expect(family.list()).toEqual([]);
  });

  it('excludes a channel from a different scope key', async () => {
    const { socket, ws } = build();
    const roomsFamily = socket.channel.scope('rooms');
    const lobbiesFamily = socket.channel.scope('lobbies');

    const roomSubscribe = roomsFamily('room-1').subscribe();
    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      __wskit: { source: 'client', channel: 'room-1', channelScope: 'rooms' },
    });
    await roomSubscribe;

    const lobbySubscribe = lobbiesFamily('lobby-1').subscribe();
    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      __wskit: { source: 'client', channel: 'lobby-1', channelScope: 'lobbies' },
    });
    await lobbySubscribe;

    expect(roomsFamily.list()).toEqual(['room-1']);
    expect(lobbiesFamily.list()).toEqual(['lobby-1']);
  });
});

describe('BUG async-subscribe', () => {
  it('unsubscribe before async payload resolves must not send __subscribe__', async () => {
    vi.useFakeTimers();
    try {
      const { socket, ws } = build();
      const room = socket.channel('general');

      let gateResolve!: () => void;
      const gate = new Promise<void>((resolve) => {
        gateResolve = resolve;
      });

      void room.subscribe(() => gate.then(() => ({ token: 'abc' })));

      room.unsubscribe();

      const framesBefore = ws.sentFrames().filter((f) => f.event === '__subscribe__').length;

      gateResolve();
      await vi.runAllTimersAsync();

      const framesAfter = ws.sentFrames().filter((f) => f.event === '__subscribe__').length;

      expect(framesAfter).toBe(framesBefore);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('BUG subscribe-promise-hang', () => {
  it('unsubscribe while pending must reject the subscribe() promise', async () => {
    const { socket, ws } = build();
    const room = socket.channel('general');

    const p = room.subscribe();

    room.unsubscribe();

    // The promise should reject, not hang. Race it against a short timeout.
    let settled = false;
    const result = await Promise.race([
      p
        .then(
          () => 'resolved',
          () => 'rejected',
        )
        .then((v) => {
          settled = true;
          return v;
        }),
      new Promise<string>((resolve) => setTimeout(() => resolve('timed-out'), 100)),
    ]);

    // Must reject (not hang and not resolve)
    expect(settled).toBe(true);
    expect(result).toBe('rejected');

    void ws;
  });
});

describe('BUG subscribe-when-active', () => {
  it('second subscribe() on an active channel must not re-send __subscribe__ or re-fire onSubscribed', async () => {
    const { socket, ws } = build();
    const room = socket.channel('general');

    const firstPromise = room.subscribe();
    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      __wskit: { source: 'client', channel: 'general' },
    });
    await firstPromise;

    const onSubscribed = vi.fn();
    room.onSubscribed(onSubscribed);

    const subscribeFramesBefore = ws.sentFrames().filter((f) => f.event === '__subscribe__').length;

    void room.subscribe();

    const subscribeFramesAfter = ws.sentFrames().filter((f) => f.event === '__subscribe__').length;

    expect(subscribeFramesAfter).toBe(subscribeFramesBefore);
    // onSubscribed must not fire again
    expect(onSubscribed).not.toHaveBeenCalled();
  });
});

describe('BUG persistence-flip', () => {
  it('persistent channel with no server auto-rejoin must eventually send __subscribe__ or fire onSubscriptionFailed', async () => {
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
        __wskit: { source: 'client', channel: 'general', channelPersistent: true },
      });

      first.serverClose(1006, 'drop');
      await vi.advanceTimersByTimeAsync(1500);
      const second = MockWebSocket.last();
      second.open();

      const onSubFailed = vi.fn();
      room.onSubscriptionFailed(onSubFailed);

      await vi.advanceTimersByTimeAsync(10_000);

      const clientSubscribe = second
        .sentFrames()
        .some((f) => f.event === '__subscribe__' && f.__wskit?.channel === 'general');

      expect(clientSubscribe || onSubFailed.mock.calls.length > 0).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('channel reconnect, lazy-hold, and presence behavior', () => {
  it('releases the lazy hold when the socket drops mid-subscribe, so a zero-consumer reconnect idle-closes', () => {
    vi.useFakeTimers();
    try {
      const socket = client<C>()(
        connect('wss://test', { lazy: true, idleTimeout: 1000 }),
        channels(),
        reconnection(),
      );
      socket
        .channel('general')
        .subscribe()
        .catch(() => undefined);
      const first = MockWebSocket.last();
      first.open();
      first.serverClose(1006); // drop before __subscribeOk__ — subscribe never activates
      vi.advanceTimersByTime(1500);
      MockWebSocket.last().open();
      vi.advanceTimersByTime(2000);
      expect(socket.getState()).toBe('closed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a disconnect within the persistent-rejoin window does not later fire a stray subscribe', () => {
    vi.useFakeTimers();
    try {
      const socket = client<C>()(connect('wss://test'), channels(), reconnection());
      socket.connect();
      MockWebSocket.last().open();
      socket.channel('general').subscribe();
      MockWebSocket.last().emit({
        event: '__subscribeOk__',
        payload: {},
        __wskit: { source: 'client', channel: 'general', channelPersistent: true },
      });
      MockWebSocket.last().serverClose(1006);
      vi.advanceTimersByTime(1500);
      MockWebSocket.last().open();
      socket.disconnect();
      socket.connect();
      const fresh = MockWebSocket.last();
      fresh.open();
      vi.advanceTimersByTime(6000);
      const subs = fresh.sentFrames().filter((f) => f.event === '__subscribe__');
      expect(subs).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not re-fire onMemberJoin for unchanged peers across a reconnect, and fires real deltas', () => {
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
        __wskit: { source: 'client', channel: 'general' },
      });
      first.emit({
        event: '__memberSync__',
        payload: { members: [{ connectionId: 'a' }, { connectionId: 'b' }] },
        __wskit: { channel: 'general' },
      });

      const joins: string[] = [];
      const leaves: string[] = [];
      room.onMemberJoin((id) => joins.push(id));
      room.onMemberLeave((id) => leaves.push(id));

      first.serverClose(1006);
      vi.advanceTimersByTime(1500);
      const second = MockWebSocket.last();
      second.open();
      second.emit({
        event: '__subscribeOk__',
        payload: {},
        __wskit: { source: 'client', channel: 'general' },
      });
      second.emit({
        event: '__memberSync__',
        payload: { members: [{ connectionId: 'a' }, { connectionId: 'c' }] },
        __wskit: { channel: 'general' },
      });

      expect(joins).toEqual(['c']);
      expect(leaves).toEqual(['b']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('reconnection give-up tears down active channels', () => {
  it('releases an active channel lazy hold and fires onUnsubscribed when reconnection gives up', () => {
    const socket = client<C>()(
      connect('wss://test', { lazy: true }),
      channels(),
      reconnection({ nonRetryableCodes: [4001] }),
    );
    const room = socket.channel('general');
    const onUnsub = vi.fn();
    room.onUnsubscribed(onUnsub);
    room.subscribe();
    const ws = MockWebSocket.last();
    ws.open();
    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      __wskit: { source: 'client', channel: 'general' },
    });
    expect((socket as unknown as { _lazyConsumers: number })._lazyConsumers).toBe(1);

    ws.serverClose(4001, 'policy');

    expect(socket.getState()).toBe('closed');
    expect((socket as unknown as { _lazyConsumers: number })._lazyConsumers).toBe(0);
    expect(onUnsub).toHaveBeenCalledTimes(1);
  });
});

describe('member join deltas after a failed rejoin', () => {
  it('reports every peer as a join on a fresh subscribe once the rejoin was rejected', () => {
    vi.useFakeTimers();
    try {
      const socket = client<C>()(connect('wss://test'), channels(), reconnection());
      socket.connect();
      const first = MockWebSocket.last();
      first.open();

      const room = socket.channel('general');
      const joins: string[] = [];
      room.onMemberJoin((id) => joins.push(id));
      room.subscribe();
      first.emit({
        event: '__subscribeOk__',
        payload: {},
        __wskit: { source: 'client', channel: 'general' },
      });
      first.emit({
        event: '__memberSync__',
        payload: { members: [{ connectionId: 'a' }] },
        __wskit: { channel: 'general' },
      });

      first.serverClose(1006, 'drop');
      vi.advanceTimersByTime(1500);
      const second = MockWebSocket.last();
      second.open();

      // Server rejects the reconnect rejoin → the channel deactivates, but the
      // stale priorMembers={a} must NOT poison the next fresh subscribe.
      second.emit({
        event: '__error__',
        payload: { code: 'forbidden' },
        __wskit: { channel: 'general' },
      });

      joins.length = 0;

      room.subscribe();
      second.emit({
        event: '__subscribeOk__',
        payload: {},
        __wskit: { source: 'client', channel: 'general' },
      });
      second.emit({
        event: '__memberSync__',
        payload: { members: [{ connectionId: 'a' }, { connectionId: 'b' }] },
        __wskit: { channel: 'general' },
      });

      expect([...joins].sort()).toEqual(['a', 'b']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports every peer as a join on a fresh subscribe after an explicit unsubscribe', () => {
    const { socket, ws } = build();
    const room = socket.channel('general');
    const joins: string[] = [];
    room.onMemberJoin((id) => joins.push(id));
    room.subscribe();
    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      __wskit: { source: 'client', channel: 'general' },
    });
    ws.emit({
      event: '__memberSync__',
      payload: { members: [{ connectionId: 'a' }] },
      __wskit: { channel: 'general' },
    });

    ws.serverClose(1006, 'drop');
    room.unsubscribe();

    joins.length = 0;

    socket.connect();
    const second = MockWebSocket.last();
    second.open();
    room.subscribe();
    second.emit({
      event: '__subscribeOk__',
      payload: {},
      __wskit: { source: 'client', channel: 'general' },
    });
    second.emit({
      event: '__memberSync__',
      payload: { members: [{ connectionId: 'a' }, { connectionId: 'b' }] },
      __wskit: { channel: 'general' },
    });

    expect([...joins].sort()).toEqual(['a', 'b']);
  });
});

describe('presence deltas across a double drop', () => {
  it('does not re-fire onMemberJoin for unchanged peers when two drops precede the rejoin', () => {
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
        __wskit: { source: 'client', channel: 'general' },
      });
      first.emit({
        event: '__memberSync__',
        payload: { members: [{ connectionId: 'a' }, { connectionId: 'b' }] },
        __wskit: { channel: 'general' },
      });

      const joins: string[] = [];
      room.onMemberJoin((id) => joins.push(id));

      first.serverClose(1006, 'drop');
      vi.advanceTimersByTime(1500);
      const second = MockWebSocket.last();
      second.open();

      // Second drop BEFORE any __memberSync__ refills members — must not clobber the stash.
      second.serverClose(1006, 'drop again');
      vi.advanceTimersByTime(1500);
      const third = MockWebSocket.last();
      third.open();

      third.emit({
        event: '__subscribeOk__',
        payload: {},
        __wskit: { source: 'client', channel: 'general' },
      });
      third.emit({
        event: '__memberSync__',
        payload: { members: [{ connectionId: 'a' }, { connectionId: 'b' }] },
        __wskit: { channel: 'general' },
      });

      expect(joins).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('duplicate subscribe confirmation', () => {
  it('fires onSubscribed once when a server-source ack follows the client-source ack', () => {
    const { socket, ws } = build();
    const room = socket.channel('general');
    const onSub = vi.fn();
    room.onSubscribed(onSub);
    room.subscribe();
    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      __wskit: { source: 'client', channel: 'general' },
    });
    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      __wskit: { source: 'server', channel: 'general' },
    });
    expect(onSub).toHaveBeenCalledTimes(1);
  });
});
