import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { channels } from '~/primitives/channels/index.ts';
import { dedup } from '~/primitives/dedup.ts';
import { inbox } from '~/primitives/inbox/inbox.ts';
import { reconnection } from '~/primitives/reconnection/index.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CursorList } from '~/primitives/inbox/types.ts';

interface C {
  channels: {
    room: {
      incoming: { msg: { text: string } };
      outgoing: { chat: { text: string } };
    };
  };
}

function build() {
  const socket = client<C>()(connect('wss://test'), channels(), dedup(), inbox(), reconnection());
  socket.connect();
  const ws = MockWebSocket.last();
  ws.open();
  return { socket, ws };
}

function subscribeOk(ws: MockWebSocket, channel: string, isInbox: boolean) {
  ws.emit({
    event: '__subscribeOk__',
    payload: {},
    __wskit: isInbox ? { source: 'client', channel, inbox: true } : { source: 'client', channel },
  });
}

/** Flush the inbox primitive's queued-microtask ack. */
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

function receivedFrames(ws: MockWebSocket) {
  return ws.sentFrames().filter((f) => f.event === '__received__');
}

let restore: () => void;
beforeEach(() => {
  restore = installMockWebSocket();
});
afterEach(() => {
  restore();
  vi.useRealTimers();
});

describe('inbox — ack gating', () => {
  it('acks __received__ only for a scope whose __subscribeOk__ carried inbox:true', async () => {
    const { ws } = build();
    subscribeOk(ws, 'room', true);

    ws.emit({ event: 'msg', payload: { text: 'hi' }, __wskit: { channel: 'room', seq: 5 } });
    await flush();

    expect(receivedFrames(ws)).toEqual([
      { event: '__received__', payload: { receivedThrough: 5 }, __wskit: { channel: 'room' } },
    ]);
  });

  it('never acks a plain (non-inbox) channel even with a seq', async () => {
    const { ws } = build();
    subscribeOk(ws, 'room', false);

    ws.emit({ event: 'msg', payload: { text: 'hi' }, __wskit: { channel: 'room', seq: 5 } });
    await flush();

    expect(receivedFrames(ws)).toEqual([]);
  });

  it('acks the per-channel high-water seq, not every message', async () => {
    const { ws } = build();
    subscribeOk(ws, 'room', true);

    ws.emit({ event: 'msg', payload: { text: 'a' }, __wskit: { channel: 'room', seq: 3 } });
    ws.emit({ event: 'msg', payload: { text: 'b' }, __wskit: { channel: 'room', seq: 7 } });
    await flush();

    expect(receivedFrames(ws)).toEqual([
      { event: '__received__', payload: { receivedThrough: 7 }, __wskit: { channel: 'room' } },
    ]);
  });

  it('carries channelFamily on the ack for a family channel', async () => {
    const { ws } = build();
    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      __wskit: { source: 'client', channel: 'room-1', channelFamily: 'rooms', inbox: true },
    });

    ws.emit({
      event: 'msg',
      payload: { text: 'hi' },
      __wskit: { channel: 'room-1', channelFamily: 'rooms', seq: 2 },
    });
    await flush();

    expect(receivedFrames(ws)).toEqual([
      {
        event: '__received__',
        payload: { receivedThrough: 2 },
        __wskit: { channel: 'room-1', channelFamily: 'rooms' },
      },
    ]);
  });
});

describe('inbox — frames that must not ack', () => {
  it('ignores a stream chunk (streamId present) on an inbox channel', async () => {
    const { ws } = build();
    subscribeOk(ws, 'room', true);

    ws.emit({
      event: 'tokens',
      payload: { text: 'x' },
      __wskit: { channel: 'room', streamId: 's-1', seq: 50 },
    });
    await flush();

    expect(receivedFrames(ws)).toEqual([]);
  });

  it('ignores a messageless frame with no seq on an inbox channel', async () => {
    const { ws } = build();
    subscribeOk(ws, 'room', true);

    ws.emit({ event: 'msg', payload: { text: 'hi' }, __wskit: { channel: 'room' } });
    await flush();

    expect(receivedFrames(ws)).toEqual([]);
  });
});

describe('inbox — scope forgetting on leave', () => {
  it('stops acking a scope after __unsubscribeOk__ and does not re-ack it on reconnect', async () => {
    vi.useFakeTimers();
    const { ws } = build();
    subscribeOk(ws, 'room', true);
    ws.emit({ event: 'msg', payload: { text: 'a' }, __wskit: { channel: 'room', seq: 4 } });
    await flush();
    expect(receivedFrames(ws)).toHaveLength(1);

    ws.emit({ event: '__unsubscribeOk__', payload: {}, __wskit: { channel: 'room' } });

    // A later message on the left channel must not be acked.
    ws.emit({ event: 'msg', payload: { text: 'b' }, __wskit: { channel: 'room', seq: 9 } });
    await flush();
    expect(receivedFrames(ws)).toHaveLength(1);

    // And a reconnect must not re-ack the forgotten scope.
    ws.serverClose(1006, 'dropped');
    vi.advanceTimersByTime(1500);
    const next = MockWebSocket.last();
    next.open();
    expect(receivedFrames(next)).toEqual([]);
  });

  it('forgets a scope on __kicked__ too', async () => {
    const { ws } = build();
    subscribeOk(ws, 'room', true);
    ws.emit({ event: 'msg', payload: { text: 'a' }, __wskit: { channel: 'room', seq: 4 } });
    await flush();

    ws.emit({ event: '__kicked__', payload: { reason: 'bye' }, __wskit: { channel: 'room' } });

    ws.emit({ event: 'msg', payload: { text: 'b' }, __wskit: { channel: 'room', seq: 9 } });
    await flush();
    expect(receivedFrames(ws)).toHaveLength(1);
  });
});

describe('inbox — reconnect re-ack', () => {
  it('re-emits the high-water __received__ for every known inbox scope on reconnect', async () => {
    vi.useFakeTimers();
    const { ws } = build();
    subscribeOk(ws, 'room', true);
    ws.emit({ event: 'msg', payload: { text: 'a' }, __wskit: { channel: 'room', seq: 6 } });
    await flush();
    expect(receivedFrames(ws)).toHaveLength(1);

    ws.serverClose(1006, 'dropped');
    vi.advanceTimersByTime(1500);
    const next = MockWebSocket.last();
    next.open();

    // The reconnect re-acks the same mark so a lost ack cannot strand the row,
    // even though dedup would drop the re-drained frame.
    expect(receivedFrames(next)).toEqual([
      { event: '__received__', payload: { receivedThrough: 6 }, __wskit: { channel: 'room' } },
    ]);
  });
});

// The received surface (`receivers`/`onReceived`/`receiversOf`) is owned by
// inbox() and is available on any inbox channel WITHOUT readReceipts() listed.
interface ReceivedC {
  channels: {
    room: {
      inbox: true;
      incoming: { msg: { text: string } };
      outgoing: { chat: { text: string } };
    };
  };
}

function buildReceived(inboxOptions?: { timeout?: number }) {
  const socket = client<ReceivedC>()(
    connect('wss://test'),
    channels(),
    dedup(),
    inbox(inboxOptions),
  );
  socket.connect();
  const ws = MockWebSocket.last();
  ws.open();
  return { socket, ws };
}

async function subscribedReceived(
  socket: ReturnType<typeof buildReceived>['socket'],
  ws: MockWebSocket,
) {
  const room = socket.channel('room');
  const p = room.subscribe();
  ws.emit({
    event: '__subscribeOk__',
    payload: {},
    __wskit: { source: 'client', channel: 'room', inbox: true },
  });
  await p;
  return room;
}

describe('inbox — receivers store from __received__ fan-out', () => {
  it('updates the reactive store and fires onReceived with a Math.max merge', async () => {
    const { socket, ws } = buildReceived();
    const room = await subscribedReceived(socket, ws);
    const events: Array<[string, number]> = [];
    room.onReceived((userId, receivedThrough) => events.push([userId, receivedThrough]));

    ws.emit({
      event: '__received__',
      payload: { userId: 'bob', receivedThrough: 5 },
      __wskit: { channel: 'room' },
    });
    // A lower value must not regress the cursor, and must not re-fire the listener.
    ws.emit({
      event: '__received__',
      payload: { userId: 'bob', receivedThrough: 3 },
      __wskit: { channel: 'room' },
    });
    // A genuine advance still fires.
    ws.emit({
      event: '__received__',
      payload: { userId: 'bob', receivedThrough: 9 },
      __wskit: { channel: 'room' },
    });

    expect(events).toEqual([
      ['bob', 5],
      ['bob', 9],
    ]);
    expect(room.receivers.get().get('bob')).toBe(9);
  });

  it('does not call onReceived or touch the store when the cursor does not advance', async () => {
    const { socket, ws } = buildReceived();
    const room = await subscribedReceived(socket, ws);
    ws.emit({
      event: '__received__',
      payload: { userId: 'bob', receivedThrough: 5 },
      __wskit: { channel: 'room' },
    });
    const snapshotAfterFirst = room.receivers.get();
    const events: Array<[string, number]> = [];
    room.onReceived((userId, receivedThrough) => events.push([userId, receivedThrough]));

    // A duplicate value.
    ws.emit({
      event: '__received__',
      payload: { userId: 'bob', receivedThrough: 5 },
      __wskit: { channel: 'room' },
    });
    // A lower value.
    ws.emit({
      event: '__received__',
      payload: { userId: 'bob', receivedThrough: 2 },
      __wskit: { channel: 'room' },
    });

    expect(events).toEqual([]);
    // The store snapshot is unchanged by reference — no subscriber notification fired.
    expect(room.receivers.get()).toBe(snapshotAfterFirst);
  });

  it('ignores a __received__ fan-out with a non-string identity', async () => {
    const { socket, ws } = buildReceived();
    const room = await subscribedReceived(socket, ws);
    ws.emit({
      event: '__received__',
      payload: { userId: 42, receivedThrough: 5 },
      __wskit: { channel: 'room' },
    });
    expect(room.receivers.get().size).toBe(0);
  });

  it('never re-acks after consuming a __received__ fan-out', async () => {
    const { socket, ws } = buildReceived();
    await subscribedReceived(socket, ws);
    ws.emit({
      event: '__received__',
      payload: { userId: 'bob', receivedThrough: 5 },
      __wskit: { channel: 'room' },
    });
    await flush();
    // The fan-out is not an app message, so it must not trigger our own ack.
    expect(receivedFrames(ws)).toEqual([]);
  });

  it('clears the store on __unsubscribeOk__', async () => {
    const { socket, ws } = buildReceived();
    const room = await subscribedReceived(socket, ws);
    ws.emit({
      event: '__received__',
      payload: { userId: 'bob', receivedThrough: 5 },
      __wskit: { channel: 'room' },
    });
    expect(room.receivers.get().size).toBe(1);

    ws.emit({ event: '__unsubscribeOk__', payload: {}, __wskit: { channel: 'room' } });
    expect(room.receivers.get().size).toBe(0);
  });
});

describe('inbox — a throwing onReceived listener', () => {
  it('surfaces on socket.onError with debug off, and does not stop the other listeners', async () => {
    const { socket, ws } = buildReceived();
    const room = await subscribedReceived(socket, ws);
    const onError = vi.fn();
    socket.onError(onError);

    const thrown = new Error('boom');
    const calls: Array<[string, number]> = [];
    room.onReceived(() => {
      throw thrown;
    });
    room.onReceived((userId, receivedThrough) => calls.push([userId, receivedThrough]));

    ws.emit({
      event: '__received__',
      payload: { userId: 'bob', receivedThrough: 5 },
      __wskit: { channel: 'room' },
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(thrown);
    expect(calls).toEqual([['bob', 5]]);
  });
});

describe('inbox — receivers projection', () => {
  it('lists each member at its received cursor, dropping members still at 0', async () => {
    const { socket, ws } = buildReceived();
    const room = await subscribedReceived(socket, ws);
    const snapshots: CursorList[] = [];
    room.receivers.subscribe((v) => snapshots.push(v));

    ws.emit({
      event: '__received__',
      payload: { userId: 'bob', receivedThrough: 5 },
      __wskit: { channel: 'room' },
    });
    expect(room.receivers.get()).toEqual(new Map([['bob', 5]]));

    ws.emit({
      event: '__received__',
      payload: { userId: 'alice', receivedThrough: 2 },
      __wskit: { channel: 'room' },
    });
    expect(room.receivers.get()).toEqual(
      new Map([
        ['bob', 5],
        ['alice', 2],
      ]),
    );
    expect(snapshots.at(-1)).toEqual(
      new Map([
        ['bob', 5],
        ['alice', 2],
      ]),
    );
  });
});

describe('inbox — receiversOf query without readReceipts()', () => {
  it('round-trips receiversOf over __receivedQuery__ with inbox() alone', async () => {
    const { socket, ws } = buildReceived();
    const room = await subscribedReceived(socket, ws);

    const promise = room.receiversOf(5);
    const query = ws
      .sentFrames()
      .filter((f) => f.event === '__receivedQuery__')
      .at(-1);
    expect(query.payload).toEqual({ seq: 5 });

    ws.emit({
      event: '__receivedQuery__',
      payload: { userIds: ['alice', 'bob'] },
      __wskit: { channel: 'room', correlationId: query.__wskit.correlationId },
    });

    await expect(promise).resolves.toEqual(['alice', 'bob']);
  });

  it('honours the inbox() factory default timeout for receiversOf', async () => {
    vi.useFakeTimers();
    const { socket, ws } = buildReceived({ timeout: 250 });
    const room = await subscribedReceived(socket, ws);

    const promise = room.receiversOf(5);
    const rejection = expect(promise).rejects.toMatchObject({ code: 'timeout' });
    vi.advanceTimersByTime(251);
    await rejection;
  });

  it('rejects a pending receiversOf with Disconnected when the socket closes', async () => {
    const { socket, ws } = buildReceived();
    const room = await subscribedReceived(socket, ws);

    const promise = room.receiversOf(5);
    socket.disconnect();

    await expect(promise).rejects.toMatchObject({ code: 'disconnected' });
  });
});
