import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { channels } from '~/primitives/channels/index.ts';
import { reconnection } from '~/primitives/reconnection/index.ts';
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
        payload: { source: 'client' },
        __wskit: { channel: 'general' },
      });

      // Drop the connection — this calls onClose (clears pending, clears members).
      // Channel stays active so onReconnect will re-subscribe.
      first.serverClose(1006, 'drop');

      vi.advanceTimersByTime(1500);
      const second = MockWebSocket.last();
      second.open();

      // At this point the channel re-subscribed with no pending promise.
      const onSubFailed = vi.fn();
      room.onSubscriptionFailed(onSubFailed);

      // Server rejects the reconnect re-subscribe.
      second.emit({
        event: '__error__',
        payload: { code: 'forbidden' },
        __wskit: { channel: 'general' },
      });

      // Because pending is null, the else branch fires onSubscriptionFailed listeners.
      expect(onSubFailed).toHaveBeenCalledWith(expect.objectContaining({ code: 'forbidden' }));

      // The rejected re-subscribe also clears the channel: it is no longer active,
      // so send() throws instead of silently sending into a channel the server
      // has no membership for, and onReconnect won't keep retrying it.
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
      // Server confirms AND marks the channel persistent (durable membership).
      first.emit({
        event: '__subscribeOk__',
        payload: { source: 'client' },
        __wskit: { channel: 'general', channelPersistent: true },
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

      // Server refuses the auto-rejoin (revalidate threw) → rejoin-rejected.
      second.emit({
        event: '__error__',
        payload: { code: 'rejoin-rejected' },
        __wskit: { channel: 'general' },
      });

      expect(onSubFailed).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'rejoin-rejected' }),
      );
      // The channel is cleared: send() throws, and it won't be retried on the next
      // reconnect — no permanent "active locally, gone on the server" divergence.
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
      payload: { source: 'client' },
      __wskit: { channel: 'general' },
    });

    const onSubFailed = vi.fn();
    room.onSubscriptionFailed(onSubFailed);

    // A channel-scoped error while steadily subscribed (no pending subscribe, no
    // reconnect) — e.g. a bad send. The listener fires, but the subscription
    // must survive: one bad message can't unsubscribe a healthy channel.
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

      // The server marks 'general' persistent on its __subscribeOk__; 'rooms' is not.
      first.emit({
        event: '__subscribeOk__',
        payload: { source: 'client' },
        __wskit: { channel: 'general', channelPersistent: true },
      });
      first.emit({
        event: '__subscribeOk__',
        payload: { source: 'client' },
        __wskit: { channel: 'room:1', channelScope: 'rooms', channelPersistent: false },
      });

      first.serverClose(1006, 'drop');
      vi.advanceTimersByTime(1500);
      const second = MockWebSocket.last();
      second.open();

      const resubscribes = second.sentFrames().filter((f) => f.event === '__subscribe__');
      // Only the non-persistent channel is re-subscribed by the client.
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
      // The server confirms AND marks the channel persistent.
      first.emit({
        event: '__subscribeOk__',
        payload: { source: 'client' },
        __wskit: { channel: 'general', channelPersistent: true },
      });

      first.serverClose(1006, 'drop');
      await vi.advanceTimersByTimeAsync(1500);
      const second = MockWebSocket.last();
      second.open();
      await vi.advanceTimersByTimeAsync(0);

      // onBeforeReopen did not re-run the function (no point — the client won't
      // re-subscribe), and onReconnect sent no __subscribe__: the server auto-rejoins.
      expect(calls).toBe(1);
      expect(second.sentFrames().some((f) => f.event === '__subscribe__')).toBe(false);
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

      // A function payload resolves asynchronously before the first __subscribe__.
      await vi.advanceTimersByTimeAsync(0);
      expect(first.sentFrames().find((f) => f.event === '__subscribe__')?.payload).toEqual({
        token: 'tok-1',
      });
      first.emit({
        event: '__subscribeOk__',
        payload: { source: 'client' },
        __wskit: { channel: 'general' },
      });

      // Drop, then let reconnection reopen — onBeforeReopen re-runs the function.
      first.serverClose(1006, 'drop');
      await vi.advanceTimersByTimeAsync(1500);
      const second = MockWebSocket.last();
      second.open();
      await vi.advanceTimersByTimeAsync(0);

      // The re-subscribe carries the refreshed token, not the stale tok-1.
      expect(second.sentFrames().find((f) => f.event === '__subscribe__')?.payload).toEqual({
        token: 'tok-2',
      });
      expect(calls).toBe(2);
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
      payload: { source: 'client' },
      __wskit: { channel: 'general' },
    });
    await subscribePromise;

    // Populate members.
    ws.emit({
      event: '__memberSync__',
      payload: { members: [{ connectionId: 'c1', meta: { name: 'Ada' } }] },
      __wskit: { channel: 'general' },
    });
    expect(room.members.size).toBe(1);

    // Simulate a network drop (not a clean disconnect).
    ws.serverClose(1006, 'drop');

    // Members cleared.
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

    // source=server — markSubscribed runs synchronously, notifyFamily fires immediately.
    ws.emit({
      event: '__subscribeOk__',
      payload: { source: 'server' },
      __wskit: { channel: 'room-42', channelScope: 'rooms' },
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
      payload: { source: 'client' },
      __wskit: { channel: 'room-42', channelScope: 'rooms' },
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

    // Server confirms with source 'server' while a subscribe() is pending.
    ws.emit({
      event: '__subscribeOk__',
      payload: { source: 'server' },
      __wskit: { channel: 'general' },
    });

    await subscribePromise;
    expect(resolved).toBe(true);
    // Channel is active — send() works.
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

    // No spurious __unsubscribe__ frame, no callback.
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
      payload: { source: 'client' },
      __wskit: { channel: 'general' },
    });

    const onUnsub = vi.fn();
    room.onUnsubscribed(onUnsub);
    room.unsubscribe();

    expect(ws.sentFrames()).toContainEqual({
      event: '__unsubscribe__',
      payload: {},
      __wskit: { channel: 'general' },
    });
    expect(onUnsub).toHaveBeenCalled();
  });
});

describe('scope-handle-list-only-active', () => {
  it('excludes a channel whose subscribe is still pending (not yet confirmed)', async () => {
    const { socket, ws } = build();
    const family = socket.channel.scope('rooms');
    family('room-pending').subscribe(); // pending, not confirmed

    // No __subscribeOk__ yet.
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
      payload: { source: 'client' },
      __wskit: { channel: 'room-x', channelScope: 'rooms' },
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
      payload: { source: 'client' },
      __wskit: { channel: 'room-1', channelScope: 'rooms' },
    });
    await roomSubscribe;

    const lobbySubscribe = lobbiesFamily('lobby-1').subscribe();
    ws.emit({
      event: '__subscribeOk__',
      payload: { source: 'client' },
      __wskit: { channel: 'lobby-1', channelScope: 'lobbies' },
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

      // subscribe with an async function that is held open by a gate
      void room.subscribe(() => gate.then(() => ({ token: 'abc' })));

      // unsubscribe before resolving the gate (channel is pending, not yet active)
      room.unsubscribe();

      const framesBefore = ws.sentFrames().filter((f) => f.event === '__subscribe__').length;

      // now resolve the gate — the late sendSubscribe should NOT fire
      gateResolve();
      await vi.runAllTimersAsync();

      const framesAfter = ws.sentFrames().filter((f) => f.event === '__subscribe__').length;

      // The unsubscribe frame was sent but no __subscribe__ should follow it
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

    // unsubscribe before any server reply
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

    void ws; // just to reference ws so linters don't complain
  });
});

describe('BUG subscribe-when-active', () => {
  it('second subscribe() on an active channel must not re-send __subscribe__ or re-fire onSubscribed', async () => {
    const { socket, ws } = build();
    const room = socket.channel('general');

    // First subscribe — let server confirm so channel goes active
    const firstPromise = room.subscribe();
    ws.emit({
      event: '__subscribeOk__',
      payload: { source: 'client' },
      __wskit: { channel: 'general' },
    });
    await firstPromise;

    const onSubscribed = vi.fn();
    room.onSubscribed(onSubscribed);

    const subscribeFramesBefore = ws.sentFrames().filter((f) => f.event === '__subscribe__').length;

    // Call subscribe() again on an already-active channel
    void room.subscribe();

    const subscribeFramesAfter = ws.sentFrames().filter((f) => f.event === '__subscribe__').length;

    // No second __subscribe__ frame should be sent
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
      // Server marks the channel persistent
      first.emit({
        event: '__subscribeOk__',
        payload: { source: 'client' },
        __wskit: { channel: 'general', channelPersistent: true },
      });

      // Drop and reconnect — server does NOT auto-resubscribe (sends nothing)
      first.serverClose(1006, 'drop');
      await vi.advanceTimersByTimeAsync(1500);
      const second = MockWebSocket.last();
      second.open();

      const onSubFailed = vi.fn();
      room.onSubscriptionFailed(onSubFailed);

      // Advance a generous window (e.g. 10 seconds) — client should fall back
      await vi.advanceTimersByTimeAsync(10_000);

      // Either the client sent its own __subscribe__ or fired onSubscriptionFailed
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
      // The only consumer is this pending subscribe; the socket lazily connects.
      socket
        .channel('general')
        .subscribe()
        .catch(() => undefined);
      const first = MockWebSocket.last();
      first.open();
      first.serverClose(1006); // drop before __subscribeOk__ — subscribe never activates
      vi.advanceTimersByTime(1500);
      MockWebSocket.last().open(); // reconnected with no live consumers
      vi.advanceTimersByTime(2000); // past the idle timeout
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
        payload: { source: 'client' },
        __wskit: { channel: 'general', channelPersistent: true },
      });
      MockWebSocket.last().serverClose(1006);
      vi.advanceTimersByTime(1500);
      MockWebSocket.last().open(); // onReconnect schedules the 5s fallback timer
      socket.disconnect(); // must cancel that timer
      socket.connect();
      const fresh = MockWebSocket.last();
      fresh.open();
      vi.advanceTimersByTime(6000); // a stale timer would fire here
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
        payload: { source: 'client' },
        __wskit: { channel: 'general' },
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
        payload: { source: 'client' },
        __wskit: { channel: 'general' },
      });
      // Reconnect roster: 'b' left, 'c' joined; 'a' unchanged.
      second.emit({
        event: '__memberSync__',
        payload: { members: [{ connectionId: 'a' }, { connectionId: 'c' }] },
        __wskit: { channel: 'general' },
      });

      expect(joins).toEqual(['c']); // not 'a' (unchanged)
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
    room.subscribe(); // lazy connect + take the idle-prevention hold
    const ws = MockWebSocket.last();
    ws.open();
    ws.emit({
      event: '__subscribeOk__',
      payload: { source: 'client' },
      __wskit: { channel: 'general' },
    });
    expect((socket as unknown as { _lazyConsumers: number })._lazyConsumers).toBe(1);

    ws.serverClose(4001, 'policy'); // non-retryable → reconnection gives up

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
        payload: { source: 'client' },
        __wskit: { channel: 'general' },
      });
      first.emit({
        event: '__memberSync__',
        payload: { members: [{ connectionId: 'a' }] },
        __wskit: { channel: 'general' },
      });

      // Drop → priorMembers stashed = {a}; reconnect → rejoin goes out.
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

      joins.length = 0; // only the fresh subscribe's joins matter now

      room.subscribe();
      second.emit({
        event: '__subscribeOk__',
        payload: { source: 'client' },
        __wskit: { channel: 'general' },
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
    const { socket, ws } = build(); // no reconnection — a drop is terminal
    const room = socket.channel('general');
    const joins: string[] = [];
    room.onMemberJoin((id) => joins.push(id));
    room.subscribe();
    ws.emit({
      event: '__subscribeOk__',
      payload: { source: 'client' },
      __wskit: { channel: 'general' },
    });
    ws.emit({
      event: '__memberSync__',
      payload: { members: [{ connectionId: 'a' }] },
      __wskit: { channel: 'general' },
    });

    // Drop → priorMembers stashed = {a}; the channel stays active.
    ws.serverClose(1006, 'drop');
    // Explicit unsubscribe → markUnsubscribed must drop the stale priorMembers.
    room.unsubscribe();

    joins.length = 0;

    // Reconnect and subscribe fresh.
    socket.connect();
    const second = MockWebSocket.last();
    second.open();
    room.subscribe();
    second.emit({
      event: '__subscribeOk__',
      payload: { source: 'client' },
      __wskit: { channel: 'general' },
    });
    second.emit({
      event: '__memberSync__',
      payload: { members: [{ connectionId: 'a' }, { connectionId: 'b' }] },
      __wskit: { channel: 'general' },
    });

    expect([...joins].sort()).toEqual(['a', 'b']);
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
      payload: { source: 'client' },
      __wskit: { channel: 'general' },
    });
    ws.emit({
      event: '__subscribeOk__',
      payload: { source: 'server' },
      __wskit: { channel: 'general' },
    });
    expect(onSub).toHaveBeenCalledTimes(1);
  });
});
