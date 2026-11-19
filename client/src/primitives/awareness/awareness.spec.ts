import { LiveThingConfigError } from '@livething/core';
import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { plugin } from '~/plugins/plugins.ts';
import { awareness } from '~/primitives/awareness/awareness.ts';
import { buffering } from '~/primitives/buffering/index.ts';
import { channels } from '~/primitives/channels/index.ts';
import { reconnection } from '~/primitives/reconnection/index.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Viewing = { viewingMessageId: string | null };

interface C {
  channels: {
    room: { awareness: Viewing; incoming: {}; outgoing: {} };
    rooms: { addressing: 'dynamic'; awareness: Viewing; incoming: {}; outgoing: {} };
  };
}

const room = { name: 'room' };

function build(options: { throttleMs?: number } = {}) {
  const socket = client<C>()(connect('wss://test'), channels(), reconnection(), awareness(options));
  socket.connect();
  const ws = MockWebSocket.last();
  ws.open('', { connectionId: 'c_me' });

  return { socket, ws, general: socket.channel('room') };
}

function subscribeOk(ws: MockWebSocket, maxBytes = 1024): void {
  ws.emit({
    event: '__subscribeOk__',
    payload: {},
    metadata: { exchange: { source: 'client' }, channel: { ...room, awareness: { maxBytes } } },
  });
}

async function joined(options: { throttleMs?: number; maxBytes?: number } = {}) {
  const built = build(options);
  const done = built.general.subscribe();
  subscribeOk(built.ws, options.maxBytes);
  await done;

  return built;
}

function sync(ws: MockWebSocket, entries: unknown[], more?: true): void {
  ws.emit({
    event: '__awarenessSync__',
    payload: { entries, ...(more ? { more } : {}) },
    metadata: { channel: room },
  });
}

function changes(ws: MockWebSocket, list: unknown[]): void {
  ws.emit({ event: '__awareness__', payload: { changes: list }, metadata: { channel: room } });
}

function sets(ws: MockWebSocket): unknown[] {
  return ws
    .sentFrames()
    .filter((frame) => frame.event === '__awarenessSet__')
    .map((frame) => frame.payload.state);
}

function refusal(ws: MockWebSocket, reason: string): void {
  ws.emit({
    event: '__error__',
    payload: { code: 'awareness-refused', detail: { event: '__awarenessSet__', reason } },
    metadata: { channel: room },
  });
}

const bob = {
  connectionId: 'c_bob',
  memberId: 'c_bob',
  meta: { name: 'Bob' },
  state: { viewingMessageId: 'm1' },
};

let restore: () => void;
beforeEach(() => {
  restore = installMockWebSocket();
  vi.useFakeTimers();
});
afterEach(() => {
  restore();
  vi.useRealTimers();
});

describe('awareness() config', () => {
  it.each([-1, 1.5, Number.NaN, 2_147_483_648])('refuses throttleMs %s', (throttleMs) => {
    expect(() => awareness({ throttleMs })).toThrow(LiveThingConfigError);
  });
});

describe('awareness() receiving', () => {
  it('can be read before the channel is joined, and fills others from the sync', async () => {
    const { socket, ws } = build();
    const general = socket.channel('room');
    expect(general.awareness.others.get().size).toBe(0);
    expect(general.awareness.synced.get()).toBe(false);

    const done = general.subscribe();
    subscribeOk(ws);
    await done;
    sync(ws, [{ ...bob, ageMs: 1000 }], true);
    expect(general.awareness.synced.get()).toBe(false);

    expect(general.awareness.others.get().size).toBe(0);

    sync(ws, [{ ...bob, connectionId: 'c_cara', memberId: 'c_cara', ageMs: 0 }]);
    expect(general.awareness.synced.get()).toBe(true);
    expect([...general.awareness.others.get().keys()]).toEqual(['c_bob', 'c_cara']);
    expect(general.awareness.others.get().get('c_bob')).toEqual({
      ...bob,
      updatedAt: Date.now() - 1000,
    });
  });

  it('applies changes: own ones to self, others to others, keeping known meta', async () => {
    const { ws, general } = await joined();
    sync(ws, []);

    changes(ws, [
      bob,
      {
        connectionId: 'c_me',
        memberId: 'c_me',
        meta: { name: 'Me' },
        state: { viewingMessageId: 'm9' },
      },
    ]);
    expect(general.awareness.self.get()?.state).toEqual({ viewingMessageId: 'm9' });
    expect([...general.awareness.others.get().keys()]).toEqual(['c_bob']);

    const before = general.awareness.others.get();
    changes(ws, [{ connectionId: 'c_bob', memberId: 'c_bob', state: { viewingMessageId: 'm2' } }]);
    expect(general.awareness.others.get()).not.toBe(before);
    expect(general.awareness.others.get().get('c_bob')).toMatchObject({
      meta: { name: 'Bob' },
      state: { viewingMessageId: 'm2' },
    });

    // An own change alone does not publish a new others Map.
    const unchanged = general.awareness.others.get();
    changes(ws, [{ connectionId: 'c_me', memberId: 'c_me', state: { viewingMessageId: 'm8' } }]);
    expect(general.awareness.others.get()).toBe(unchanged);

    changes(ws, [
      { connectionId: 'c_bob', state: null },
      { connectionId: 'c_me', state: null },
    ]);
    expect(general.awareness.others.get().size).toBe(0);
    expect(general.awareness.self.get()).toBeNull();
  });

  it('ignores a change with no meta for an unknown connection, and a clear for one', async () => {
    const { ws, general } = await joined();
    sync(ws, []);
    const before = general.awareness.others.get();

    changes(ws, [
      { connectionId: 'c_zed', memberId: 'c_zed', state: { viewingMessageId: 'm1' } },
      { connectionId: 'c_yan', state: null },
    ]);

    expect(general.awareness.others.get()).toBe(before);
  });

  it('ignores a sync frame with no entries list', async () => {
    const { ws, general } = await joined();
    sync(ws, [{ ...bob, ageMs: 0 }]);

    ws.emit({ event: '__awarenessSync__', payload: {}, metadata: { channel: room } });

    expect([...general.awareness.others.get().keys()]).toEqual(['c_bob']);
  });

  it('does not wake others listeners when an empty sync replaces an empty list', async () => {
    const { ws, general } = await joined();
    const wakes = vi.fn();
    general.awareness.others.subscribe(wakes);

    sync(ws, []);

    expect(wakes).not.toHaveBeenCalled();
    expect(general.awareness.synced.get()).toBe(true);
  });

  it('ignores frames that arrive after the channel was left', async () => {
    const { ws, general } = await joined();
    sync(ws, [{ ...bob, ageMs: 0 }]);

    void general.unsubscribe();
    expect(general.awareness.others.get().size).toBe(0);
    expect(general.awareness.synced.get()).toBe(false);

    changes(ws, [bob]);
    sync(ws, [{ ...bob, ageMs: 0 }]);
    expect(general.awareness.others.get().size).toBe(0);
  });
});

describe('awareness() sending', () => {
  it('sends the first set at once and only the newest one after the wait', async () => {
    const { ws, general } = await joined({ throttleMs: 50 });

    general.awareness.set({ viewingMessageId: 'm1' });
    general.awareness.set({ viewingMessageId: 'm2' });
    general.awareness.set({ viewingMessageId: 'm3' });
    expect(sets(ws)).toEqual([{ viewingMessageId: 'm1' }]);
    expect(general.awareness.mine.get()).toEqual({ viewingMessageId: 'm3' });

    vi.advanceTimersByTime(50);
    expect(sets(ws)).toEqual([{ viewingMessageId: 'm1' }, { viewingMessageId: 'm3' }]);
    expect(ws.sentFrames().at(-1).metadata).toEqual({ channel: room });
  });

  it('does not send the same state twice after A, B, A inside one wait', async () => {
    const { ws, general } = await joined({ throttleMs: 50 });

    general.awareness.set({ viewingMessageId: 'm1' });
    general.awareness.set({ viewingMessageId: 'm2' });
    general.awareness.set({ viewingMessageId: 'm1' });
    vi.advanceTimersByTime(200);

    expect(sets(ws)).toEqual([{ viewingMessageId: 'm1' }]);
  });

  it('keeps a copy in mine, not the object the app passed', async () => {
    const { general } = await joined();
    const state = { viewingMessageId: 'm1' };

    general.awareness.set(state);
    state.viewingMessageId = 'changed';

    expect(general.awareness.mine.get()).toEqual({ viewingMessageId: 'm1' });
  });

  it('sends the state as set() checked it, even if the app changes mine.get() during the wait', async () => {
    const { ws, general } = await joined({ throttleMs: 50, maxBytes: 64 });
    general.awareness.set({ viewingMessageId: 'm1' });
    general.awareness.set({ viewingMessageId: 'm2' });

    (general.awareness.mine.get() as Viewing).viewingMessageId = 'x'.repeat(100);
    vi.advanceTimersByTime(50);

    expect(sets(ws)).toEqual([{ viewingMessageId: 'm1' }, { viewingMessageId: 'm2' }]);
  });

  it('refuses a state too large or not a plain JSON object, and keeps mine', async () => {
    const { ws, general } = await joined({ maxBytes: 30 });
    const refused: string[] = [];
    general.awareness.onRefused(({ reason }) => refused.push(reason));
    general.awareness.set({ viewingMessageId: 'm1' });

    general.awareness.set({ viewingMessageId: 'x'.repeat(40) });
    general.awareness.set([] as never);
    general.awareness.set({ viewingMessageId: 1n } as never);

    expect(refused).toEqual(['too-large', 'invalid', 'invalid']);
    expect(general.awareness.mine.get()).toEqual({ viewingMessageId: 'm1' });
    vi.advanceTimersByTime(1000);
    expect(sets(ws)).toEqual([{ viewingMessageId: 'm1' }]);
  });

  it('ignores set() on a channel that is not joined, without throwing', () => {
    const { ws, general } = build();

    general.awareness.set({ viewingMessageId: 'm1' });

    expect(general.awareness.mine.get()).toBeNull();
    expect(sets(ws)).toEqual([]);
  });

  it('clears at once and drops a waiting set; a clear with nothing to clear sends nothing', async () => {
    const { ws, general } = await joined();
    general.awareness.clear();
    expect(sets(ws)).toEqual([]);

    general.awareness.set({ viewingMessageId: 'm1' });
    general.awareness.set({ viewingMessageId: 'm2' });
    general.awareness.clear();
    vi.advanceTimersByTime(1000);

    expect(sets(ws)).toEqual([{ viewingMessageId: 'm1' }, null]);
    expect(general.awareness.mine.get()).toBeNull();
  });
});

describe('awareness() refusals', () => {
  it('claims a refusal, so it never reaches onServerError', async () => {
    const { socket, ws, general } = await joined();
    const onServerError = vi.fn();
    socket.onServerError(onServerError);
    const refused = vi.fn();
    general.awareness.onRefused(refused);

    refusal(ws, 'check');
    refusal(ws, 'something-new');

    expect(refused.mock.calls).toEqual([[{ reason: 'check' }], [{ reason: 'error' }]]);
    expect(onServerError).not.toHaveBeenCalled();
  });

  it('stops sending after the server says it has no awareness on the channel', async () => {
    const { socket, ws, general } = await joined();
    const onServerError = vi.fn();
    socket.onServerError(onServerError);
    general.awareness.set({ viewingMessageId: 'm1' });

    ws.emit({
      event: '__error__',
      payload: { code: 'unsupported-protocol', detail: { event: '__awarenessSet__' } },
      metadata: { channel: room },
    });
    general.awareness.set({ viewingMessageId: 'm2' });
    vi.advanceTimersByTime(1000);

    expect(onServerError).not.toHaveBeenCalled();
    expect(general.awareness.mine.get()).toBeNull();
    expect(sets(ws)).toEqual([{ viewingMessageId: 'm1' }]);
  });

  it('sends again after a later __subscribeOk__ says the channel has awareness', async () => {
    const { ws, general } = await joined();
    ws.emit({
      event: '__error__',
      payload: { code: 'unsupported-protocol', detail: { event: '__awarenessSet__' } },
      metadata: { channel: room },
    });

    subscribeOk(ws);
    general.awareness.set({ viewingMessageId: 'm2' });

    expect(sets(ws)).toEqual([{ viewingMessageId: 'm2' }]);
  });
});

describe('awareness() reconnecting', () => {
  async function dropAndRejoin(
    ws: MockWebSocket,
    maxBytes = 1024,
    connectionId = 'c_me2',
  ): Promise<MockWebSocket> {
    ws.serverClose(1006, 'drop');
    vi.advanceTimersByTime(1500);
    const next = MockWebSocket.last();
    next.open('', { connectionId });
    subscribeOk(next, maxBytes);

    await vi.advanceTimersByTimeAsync(0);

    return next;
  }

  it('keeps others through a drop, clears self, and sends mine again once', async () => {
    const { ws, general } = await joined();
    sync(ws, [{ ...bob, ageMs: 0 }]);
    general.awareness.set({ viewingMessageId: 'm1' });
    changes(ws, [
      { connectionId: 'c_me', memberId: 'c_me', meta: {}, state: { viewingMessageId: 'm1' } },
    ]);

    ws.serverClose(1006, 'drop');
    expect(general.awareness.self.get()).toBeNull();
    expect(general.awareness.synced.get()).toBe(false);
    expect(general.awareness.others.get().size).toBe(1);

    vi.advanceTimersByTime(1500);
    const next = MockWebSocket.last();
    next.open('', { connectionId: 'c_me2' });
    subscribeOk(next);
    await vi.advanceTimersByTimeAsync(0);

    expect(sets(next)).toEqual([{ viewingMessageId: 'm1' }]);
  });

  it('drops sync entries and changes for its own earlier connection', async () => {
    const { ws, general } = await joined();
    const next = await dropAndRejoin(ws);

    sync(next, [
      { ...bob, ageMs: 0 },
      { ...bob, connectionId: 'c_me', memberId: 'c_me', ageMs: 0 },
    ]);
    changes(next, [
      { connectionId: 'c_me', memberId: 'c_me', meta: {}, state: { viewingMessageId: 'm3' } },
    ]);

    expect([...general.awareness.others.get().keys()]).toEqual(['c_bob']);
    expect(general.awareness.self.get()).toBeNull();
  });

  it('does not take a refusal during a rejoin as a failed rejoin', async () => {
    const { ws, general } = await joined();
    const refused = vi.fn();
    general.awareness.onRefused(refused);

    ws.serverClose(1006, 'drop');
    vi.advanceTimersByTime(1500);
    const next = MockWebSocket.last();
    next.open('', { connectionId: 'c_me2' });
    expect(general.status.get()).toBe('subscribing');

    refusal(next, 'check');

    expect(refused).toHaveBeenCalledWith({ reason: 'check' });
    expect(general.status.get()).toBe('subscribing');
  });

  it('measures mine again against a lowered maxBytes after a rejoin', async () => {
    const { ws, general } = await joined();
    general.awareness.set({ viewingMessageId: 'm1' });
    const refused = vi.fn();
    general.awareness.onRefused(refused);

    const next = await dropAndRejoin(ws, 10);

    expect(refused).toHaveBeenCalledWith({ reason: 'too-large' });
    expect(sets(next)).toEqual([]);
  });

  it('leaves no stale entry when a drop cuts a sync between two pieces', async () => {
    const { ws, general } = await joined();
    sync(ws, [{ ...bob, connectionId: 'c_dan', memberId: 'c_dan', ageMs: 0 }]);
    sync(ws, [{ ...bob, ageMs: 0 }], true);

    const next = await dropAndRejoin(ws);
    sync(next, [{ ...bob, connectionId: 'c_cara', memberId: 'c_cara', ageMs: 0 }]);

    expect([...general.awareness.others.get().keys()]).toEqual(['c_cara']);
  });

  it('drops entries of only the last 8 own connection IDs', async () => {
    const { ws, general } = await joined();
    let current = ws;
    for (let i = 1; i <= 9; i += 1) {
      current = await dropAndRejoin(current, 1024, `c_${i}`);
    }

    const ids = ['c_me', 'c_1', 'c_2', 'c_8', 'c_9'];
    sync(
      current,
      ids.map((id) => ({ ...bob, connectionId: id, memberId: id, ageMs: 0 })),
    );

    expect([...general.awareness.others.get().keys()]).toEqual(['c_me']);
  });

  it('resets and stops sending when a rejoin has no awareness metadata, until one has it again', async () => {
    const { ws, general } = await joined();
    general.awareness.set({ viewingMessageId: 'm1' });
    ws.serverClose(1006, 'drop');
    vi.advanceTimersByTime(1500);

    const next = MockWebSocket.last();
    next.open('', { connectionId: 'c_me2' });
    next.emit({
      event: '__subscribeOk__',
      payload: {},
      metadata: { exchange: { source: 'client' }, channel: room },
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(general.awareness.mine.get()).toBeNull();
    general.awareness.set({ viewingMessageId: 'm2' });
    expect(sets(next)).toEqual([]);

    subscribeOk(next);
    general.awareness.set({ viewingMessageId: 'm3' });
    expect(sets(next)).toEqual([{ viewingMessageId: 'm3' }]);
  });

  it('builds the state for a server-pushed subscribe that had no handle', () => {
    const { socket, ws } = build();

    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      metadata: {
        exchange: { source: 'server' },
        channel: { ...room, awareness: { maxBytes: 1024 } },
      },
    });
    sync(ws, [{ ...bob, ageMs: 0 }]);

    const general = socket.channel('room');
    expect([...general.awareness.others.get().keys()]).toEqual(['c_bob']);
    expect(general.awareness.synced.get()).toBe(true);
  });
});

describe('awareness() on a family channel', () => {
  function familyOk(ws: MockWebSocket, name: string): void {
    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      metadata: {
        exchange: { source: 'client' },
        channel: { name, family: 'rooms', awareness: { maxBytes: 1024 } },
      },
    });
  }

  it('sends the family with each set and gives a refusal only to its own handle', async () => {
    const { socket, ws } = build();
    const a = socket.channel('rooms', 'room:a');
    const b = socket.channel('rooms', 'room:b');

    const done = Promise.all([a.subscribe(), b.subscribe()]);
    familyOk(ws, 'room:a');
    familyOk(ws, 'room:b');
    await done;

    const refusedA = vi.fn();
    const refusedB = vi.fn();
    a.awareness.onRefused(refusedA);
    b.awareness.onRefused(refusedB);

    a.awareness.set({ viewingMessageId: 'm1' });
    ws.emit({
      event: '__error__',
      payload: {
        code: 'awareness-refused',
        detail: { event: '__awarenessSet__', reason: 'check' },
      },
      metadata: { channel: { name: 'room:b', family: 'rooms' } },
    });

    expect(ws.sentFrames().at(-1).metadata).toEqual({
      channel: { name: 'room:a', family: 'rooms' },
    });
    expect(refusedB).toHaveBeenCalledWith({ reason: 'check' });
    expect(refusedA).not.toHaveBeenCalled();
  });
});

describe('awareness() with buffering()', () => {
  it('queues no set while the socket is down and sends it once after the rejoin', async () => {
    const socket = client<C>()(
      connect('wss://test'),
      channels(),
      reconnection(),
      buffering(),
      awareness(),
    );
    socket.connect();
    const ws = MockWebSocket.last();
    ws.open('', { connectionId: 'c_me' });

    const general = socket.channel('room');
    const done = general.subscribe();
    subscribeOk(ws);
    await done;

    ws.serverClose(1006, 'drop');
    general.awareness.set({ viewingMessageId: 'm1' });
    vi.advanceTimersByTime(1500);

    const next = MockWebSocket.last();
    next.open('', { connectionId: 'c_me2' });
    subscribeOk(next);
    await vi.advanceTimersByTimeAsync(1000);

    expect(sets(ws)).toEqual([]);
    expect(sets(next)).toEqual([{ viewingMessageId: 'm1' }]);
  });
});

describe('awareness() leaving and failing', () => {
  async function filled() {
    const built = await joined();
    sync(built.ws, [{ ...bob, ageMs: 0 }]);
    built.general.awareness.set({ viewingMessageId: 'm1' });
    changes(built.ws, [
      { connectionId: 'c_me', memberId: 'c_me', meta: {}, state: { viewingMessageId: 'm1' } },
    ]);

    return built;
  }

  function expectEmpty(general: Awaited<ReturnType<typeof joined>>['general']): void {
    expect(general.awareness.mine.get()).toBeNull();
    expect(general.awareness.self.get()).toBeNull();
    expect(general.awareness.others.get().size).toBe(0);
    expect(general.awareness.synced.get()).toBe(false);
  }

  it('resets everything on a kick', async () => {
    const { ws, general } = await filled();

    ws.emit({ event: '__kicked__', payload: { reason: 'bye' }, metadata: { channel: room } });

    expectEmpty(general);
  });

  it('resets everything when a rejoin fails', async () => {
    const { ws, general } = await filled();
    ws.serverClose(1006, 'drop');
    vi.advanceTimersByTime(1500);
    const next = MockWebSocket.last();
    next.open('', { connectionId: 'c_me2' });

    next.emit({ event: '__error__', payload: { code: 'forbidden' }, metadata: { channel: room } });

    expect(general.status.get()).toBe('failed');
    expectEmpty(general);
  });

  it('leaves no timer after unsubscribe', async () => {
    const { general } = await joined();
    const baseline = vi.getTimerCount();

    general.awareness.set({ viewingMessageId: 'm1' });
    void general.unsubscribe();

    expect(vi.getTimerCount()).toBeLessThanOrEqual(baseline);
  });

  it('leaves no timer after a kick', async () => {
    const { ws, general } = await joined();
    const baseline = vi.getTimerCount();

    general.awareness.set({ viewingMessageId: 'm1' });
    ws.emit({ event: '__kicked__', payload: {}, metadata: { channel: room } });

    expect(vi.getTimerCount()).toBeLessThanOrEqual(baseline);
  });

  it('leaves no timer after a disconnect', async () => {
    const { socket, general } = await joined();
    const baseline = vi.getTimerCount();

    general.awareness.set({ viewingMessageId: 'm1' });
    socket.disconnect();

    expect(vi.getTimerCount()).toBeLessThanOrEqual(baseline);
  });
});

describe('awareness() set() on the subscribed event', () => {
  type General = ReturnType<typeof build>['general'];
  type Register = (general: General, run: () => void) => unknown;
  const callers: [string, Register][] = [
    [
      'a status listener registered first',
      (general, run) => general.status.subscribe((status) => status === 'subscribed' && run()),
    ],
    ['onSubscribed', (general, run) => general.onSubscribed(run)],
  ];

  it.each(callers)('with %s, refuses a too-large state', async (_name, register) => {
    const { ws, general } = build();
    const refused = vi.fn();
    register(general, () => general.awareness.set({ viewingMessageId: 'x'.repeat(40) }));
    general.awareness.onRefused(refused);

    const done = general.subscribe();
    subscribeOk(ws, 30);
    await done;

    expect(refused).toHaveBeenCalledWith({ reason: 'too-large' });
    expect(sets(ws)).toEqual([]);
  });

  it.each(callers)('with %s, sends a valid state exactly once', async (_name, register) => {
    const { ws, general } = build();
    register(general, () => general.awareness.set({ viewingMessageId: 'm1' }));

    const done = general.subscribe();
    subscribeOk(ws, 30);
    await done;
    vi.advanceTimersByTime(1000);

    expect(sets(ws)).toEqual([{ viewingMessageId: 'm1' }]);
  });
});

describe('awareness() on plugin channels', () => {
  interface DocsWire {
    channels: {
      feed: { awareness: Viewing; incoming: {}; outgoing: {} };
      docs: { addressing: 'dynamic'; awareness: Viewing; incoming: {}; outgoing: {} };
    };
  }

  interface Host {
    channels: {
      '__acme:docs::feed': DocsWire['channels']['feed'];
      '__acme:docs::docs': DocsWire['channels']['docs'];
    };
  }

  const Docs = plugin<DocsWire>()({
    id: 'acme:docs',
    dependencies: [channels, awareness],
    setup(socket) {
      return {
        api: () => ({ feed: socket.channel('feed'), launch: socket.channel('docs', 'doc:launch') }),
      };
    },
  });

  it.each([
    ['a fixed channel', 'feed', { name: '__acme:docs::feed' }],
    ['a family room', 'launch', { name: 'doc:launch', family: '__acme:docs::docs' }],
  ] as const)('sends, receives and refuses on %s by its wire name', async (_, key, wire) => {
    const socket = client<Host>()(connect('wss://test'), channels(), awareness(), Docs());
    socket.connect();
    const ws = MockWebSocket.last();
    ws.open('', { connectionId: 'c_me' });
    const handle = Docs.use(socket)[key];

    const done = handle.subscribe();
    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      metadata: {
        exchange: { source: 'client' },
        channel: { ...wire, awareness: { maxBytes: 1024 } },
      },
    });
    await done;
    ws.emit({
      event: '__awarenessSync__',
      payload: { entries: [{ ...bob, ageMs: 0 }] },
      metadata: { channel: wire },
    });
    expect(handle.awareness.synced.get()).toBe(true);

    expect([...handle.awareness.others.get().keys()]).toEqual(['c_bob']);

    handle.awareness.set({ viewingMessageId: 'm2' });
    const sent = ws.sentFrames().filter((frame) => frame.event === '__awarenessSet__');
    expect(sent).toEqual([
      expect.objectContaining({
        payload: { state: { viewingMessageId: 'm2' } },
        metadata: { channel: wire },
      }),
    ]);

    const refused = vi.fn();
    handle.awareness.onRefused(refused);
    ws.emit({
      event: '__error__',
      payload: {
        code: 'awareness-refused',
        detail: { event: '__awarenessSet__', reason: 'check' },
      },
      metadata: { channel: wire },
    });
    expect(refused).toHaveBeenCalledWith({ reason: 'check' });

    ws.emit({
      event: '__awareness__',
      payload: { changes: [{ connectionId: 'c_bob', state: null }] },
      metadata: { channel: wire },
    });
    expect(handle.awareness.others.get().size).toBe(0);
  });
});
