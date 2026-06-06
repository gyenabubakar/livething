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
  it('channel goes active but subscribe() promise stays unresolved when source=server', async () => {
    const { socket, ws } = build();
    const room = socket.channel('general');

    let resolved = false;
    let rejected = false;
    const subscribePromise = room.subscribe();
    subscribePromise.then(
      () => {
        resolved = true;
      },
      () => {
        rejected = true;
      },
    );

    // Server pushes __subscribeOk__ with source 'server' while there is a pending promise.
    ws.emit({
      event: '__subscribeOk__',
      payload: { source: 'server' },
      __wskit: { channel: 'general' },
    });

    // Flush microtasks.
    await new Promise((r) => setTimeout(r, 0));

    // Channel is active — send() works.
    expect(() => room.send('send-message', { text: 'ok' })).not.toThrow();

    // But the subscribe() promise was never resolved or rejected.
    expect(resolved).toBe(false);
    expect(rejected).toBe(false);
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
