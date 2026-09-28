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

interface FamilyC {
  channels: {
    rooms: {
      addressing: 'dynamic';
      inbox: true;
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

function buildFamilyReceived() {
  const socket = client<FamilyC>()(
    connect('wss://test'),
    channels(),
    dedup(),
    inbox(),
    reconnection(),
  );
  socket.connect();
  const ws = MockWebSocket.last();
  ws.open();

  return { socket, ws };
}

function subscribeOk(ws: MockWebSocket, channel: string, isInbox: boolean) {
  ws.emit({
    event: '__subscribeOk__',
    payload: null,
    metadata: {
      exchange: { source: 'client' },
      channel: { name: channel, ...(isInbox ? { inbox: true } : {}) },
    },
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

    ws.emit({
      event: 'msg',
      payload: { text: 'hi' },
      metadata: { channel: { name: 'room' }, delivery: { seq: 5 } },
    });
    await flush();

    expect(receivedFrames(ws)).toEqual([
      {
        event: '__received__',
        payload: { receivedThrough: 5 },
        metadata: { channel: { name: 'room' } },
      },
    ]);
  });

  it('never acks a plain (non-inbox) channel even with a seq', async () => {
    const { ws } = build();
    subscribeOk(ws, 'room', false);

    ws.emit({
      event: 'msg',
      payload: { text: 'hi' },
      metadata: { channel: { name: 'room' }, delivery: { seq: 5 } },
    });
    await flush();

    expect(receivedFrames(ws)).toEqual([]);
  });

  it('acks the per-channel high-water seq, not every message', async () => {
    const { ws } = build();
    subscribeOk(ws, 'room', true);

    ws.emit({
      event: 'msg',
      payload: { text: 'a' },
      metadata: { channel: { name: 'room' }, delivery: { seq: 3 } },
    });
    ws.emit({
      event: 'msg',
      payload: { text: 'b' },
      metadata: { channel: { name: 'room' }, delivery: { seq: 7 } },
    });
    await flush();

    expect(receivedFrames(ws)).toEqual([
      {
        event: '__received__',
        payload: { receivedThrough: 7 },
        metadata: { channel: { name: 'room' } },
      },
    ]);
  });

  it('carries channelFamily on the ack for a family channel', async () => {
    const { ws } = build();
    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      metadata: {
        exchange: { source: 'client' },
        channel: { name: 'room-1', family: 'rooms', inbox: true },
      },
    });

    ws.emit({
      event: 'msg',
      payload: { text: 'hi' },
      metadata: { channel: { name: 'room-1', family: 'rooms' }, delivery: { seq: 2 } },
    });
    await flush();

    expect(receivedFrames(ws)).toEqual([
      {
        event: '__received__',
        payload: { receivedThrough: 2 },
        metadata: { channel: { name: 'room-1', family: 'rooms' } },
      },
    ]);
  });

  it('does not let a stale family leave id clear another family member', async () => {
    const { socket, ws } = buildFamilyReceived();
    const first = socket.channel('rooms', 'room-1');
    const second = socket.channel('rooms', 'room-2');

    const firstSubscribe = first.subscribe();
    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      metadata: {
        exchange: { source: 'client' },
        channel: { name: 'room-1', family: 'rooms', inbox: true },
      },
    });
    await firstSubscribe;

    const secondSubscribe = second.subscribe();
    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      metadata: {
        exchange: { source: 'client' },
        channel: { name: 'room-2', family: 'rooms', inbox: true },
      },
    });
    await secondSubscribe;

    ws.emit({
      event: '__received__',
      payload: { userId: 'bob', receivedThrough: 5 },
      metadata: { channel: { name: 'room-1', family: 'rooms' } },
    });
    ws.emit({
      event: '__received__',
      payload: { userId: 'bob', receivedThrough: 7 },
      metadata: { channel: { name: 'room-2', family: 'rooms' } },
    });

    const leave = first.unsubscribe();
    const unsubscribeId = ws.sentFrames().at(-1).metadata.channel?.unsubscribeId;
    const rejoin = first.subscribe();
    ws.emit({
      event: '__unsubscribeOk__',
      payload: {},
      metadata: { channel: { name: 'room-1', family: 'rooms', unsubscribeId: unsubscribeId } },
    });
    await leave;

    // The id belongs to room-1, even though it is still a stale frame for the
    // active room-2 scope. It must not clear room-2's receipt cursor.
    ws.emit({
      event: '__unsubscribeOk__',
      payload: {},
      metadata: { channel: { name: 'room-2', family: 'rooms', unsubscribeId: unsubscribeId } },
    });
    expect(second.receivers.get()).toEqual(new Map([['bob', 7]]));

    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      metadata: {
        exchange: { source: 'client' },
        channel: { name: 'room-1', family: 'rooms', inbox: true },
      },
    });
    await rejoin;
    expect(first.receivers.get()).toEqual(new Map([['bob', 5]]));
  });
});

describe('inbox — frames that must not ack', () => {
  it('ignores a stream chunk (streamId present) on an inbox channel', async () => {
    const { ws } = build();
    subscribeOk(ws, 'room', true);

    ws.emit({
      event: 'tokens',
      payload: { text: 'x' },
      metadata: { channel: { name: 'room' }, stream: { id: 's-1', seq: 50 } },
    });
    await flush();

    expect(receivedFrames(ws)).toEqual([]);
  });

  it('ignores a messageless frame with no seq on an inbox channel', async () => {
    const { ws } = build();
    subscribeOk(ws, 'room', true);

    ws.emit({ event: 'msg', payload: { text: 'hi' }, metadata: { channel: { name: 'room' } } });
    await flush();

    expect(receivedFrames(ws)).toEqual([]);
  });
});

describe('inbox — scope forgetting on leave', () => {
  it('stops acking a scope after __unsubscribeOk__ and does not re-ack it on reconnect', async () => {
    vi.useFakeTimers();
    const { socket, ws } = build();
    const room = socket.channel('room');
    const subscribed = room.subscribe();
    subscribeOk(ws, 'room', true);

    await subscribed;
    expect(room.status.get()).toBe('subscribed');

    ws.emit({
      event: 'msg',
      payload: { text: 'a' },
      metadata: { channel: { name: 'room' }, delivery: { seq: 4 } },
    });
    await flush();
    expect(receivedFrames(ws)).toHaveLength(1);

    const leave = room.unsubscribe();
    expect(room.status.get()).toBe('unsubscribed');
    const unsubscribeId = ws.sentFrames().at(-1).metadata.channel?.unsubscribeId;
    ws.emit({
      event: '__unsubscribeOk__',
      payload: {},
      metadata: { channel: { name: 'room', unsubscribeId: unsubscribeId } },
    });
    await leave;

    expect(room.status.get()).toBe('unsubscribed');

    // A later message on the left channel must not be acked.
    ws.emit({
      event: 'msg',
      payload: { text: 'b' },
      metadata: { channel: { name: 'room' }, delivery: { seq: 9 } },
    });
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
    ws.emit({
      event: 'msg',
      payload: { text: 'a' },
      metadata: { channel: { name: 'room' }, delivery: { seq: 4 } },
    });
    await flush();

    ws.emit({
      event: '__kicked__',
      payload: { reason: 'bye' },
      metadata: { channel: { name: 'room' } },
    });

    ws.emit({
      event: 'msg',
      payload: { text: 'b' },
      metadata: { channel: { name: 'room' }, delivery: { seq: 9 } },
    });
    await flush();
    expect(receivedFrames(ws)).toHaveLength(1);
  });
});

describe('inbox — reconnect re-ack', () => {
  it('re-emits the high-water __received__ for every known inbox scope on reconnect', async () => {
    vi.useFakeTimers();
    const { ws } = build();
    subscribeOk(ws, 'room', true);
    ws.emit({
      event: 'msg',
      payload: { text: 'a' },
      metadata: { channel: { name: 'room' }, delivery: { seq: 6 } },
    });
    await flush();

    expect(receivedFrames(ws)).toHaveLength(1);

    ws.serverClose(1006, 'dropped');
    vi.advanceTimersByTime(1500);
    const next = MockWebSocket.last();
    next.open();

    // The reconnect re-acks the same mark so a lost ack cannot strand the row,
    // even though dedup would drop the re-drained frame.
    expect(receivedFrames(next)).toEqual([
      {
        event: '__received__',
        payload: { receivedThrough: 6 },
        metadata: { channel: { name: 'room' } },
      },
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
    metadata: { exchange: { source: 'client' }, channel: { name: 'room', inbox: true } },
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
      metadata: { channel: { name: 'room' } },
    });
    // A lower value must not regress the cursor, and must not re-fire the listener.
    ws.emit({
      event: '__received__',
      payload: { userId: 'bob', receivedThrough: 3 },
      metadata: { channel: { name: 'room' } },
    });
    // A genuine advance still fires.
    ws.emit({
      event: '__received__',
      payload: { userId: 'bob', receivedThrough: 9 },
      metadata: { channel: { name: 'room' } },
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
      metadata: { channel: { name: 'room' } },
    });
    const snapshotAfterFirst = room.receivers.get();
    const events: Array<[string, number]> = [];

    room.onReceived((userId, receivedThrough) => events.push([userId, receivedThrough]));

    // A duplicate value.
    ws.emit({
      event: '__received__',
      payload: { userId: 'bob', receivedThrough: 5 },
      metadata: { channel: { name: 'room' } },
    });
    // A lower value.
    ws.emit({
      event: '__received__',
      payload: { userId: 'bob', receivedThrough: 2 },
      metadata: { channel: { name: 'room' } },
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
      metadata: { channel: { name: 'room' } },
    });
    expect(room.receivers.get().size).toBe(0);
  });

  it('never re-acks after consuming a __received__ fan-out', async () => {
    const { socket, ws } = buildReceived();
    await subscribedReceived(socket, ws);
    ws.emit({
      event: '__received__',
      payload: { userId: 'bob', receivedThrough: 5 },
      metadata: { channel: { name: 'room' } },
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
      metadata: { channel: { name: 'room' } },
    });
    expect(room.receivers.get().size).toBe(1);

    const leave = room.unsubscribe();
    expect(room.status.get()).toBe('unsubscribed');
    const unsubscribeId = ws.sentFrames().at(-1).metadata.channel?.unsubscribeId;
    ws.emit({
      event: '__unsubscribeOk__',
      payload: {},
      metadata: { channel: { name: 'room', unsubscribeId: unsubscribeId } },
    });
    await leave;

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
      metadata: { channel: { name: 'room' } },
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
      metadata: { channel: { name: 'room' } },
    });
    expect(room.receivers.get()).toEqual(new Map([['bob', 5]]));

    ws.emit({
      event: '__received__',
      payload: { userId: 'alice', receivedThrough: 2 },
      metadata: { channel: { name: 'room' } },
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
      metadata: { exchange: { id: query.metadata.exchange?.id }, channel: { name: 'room' } },
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

describe('inbox — a stale __unsubscribeOk__ arriving after a rejoin is already under way', () => {
  it('keeps acknowledging a message that arrives in the gap between the stale confirmation and the rejoin landing', async () => {
    const { socket, ws } = buildReceived();
    const room = await subscribedReceived(socket, ws);

    ws.emit({
      event: 'msg',
      payload: { text: 'a' },
      metadata: { channel: { name: 'room' }, delivery: { seq: 5 } },
    });
    await flush();
    expect(receivedFrames(ws)).toEqual([
      {
        event: '__received__',
        payload: { receivedThrough: 5 },
        metadata: { channel: { name: 'room' } },
      },
    ]);

    // Leave, then immediately rejoin before the leave is confirmed — the rejoin
    // is deferred behind the leave and only sent once it settles.
    const leave = room.unsubscribe();
    const staleUnsubscribeId = ws.sentFrames().at(-1).metadata.channel?.unsubscribeId;
    const rejoin = room.subscribe();

    // The server's confirmation for the leave arrives while the member is
    // already coming back — the rejoin's own __subscribeOk__ has not landed yet.
    ws.emit({
      event: '__unsubscribeOk__',
      payload: {},
      metadata: { channel: { name: 'room', unsubscribeId: staleUnsubscribeId } },
    });
    await leave;

    // A message arrives in that gap, before the rejoin is confirmed.
    ws.emit({
      event: 'msg',
      payload: { text: 'b' },
      metadata: { channel: { name: 'room' }, delivery: { seq: 6 } },
    });
    await flush();

    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      metadata: { exchange: { source: 'client' }, channel: { name: 'room', inbox: true } },
    });
    await rejoin;

    expect(receivedFrames(ws).at(-1)).toEqual({
      event: '__received__',
      payload: { receivedThrough: 6 },
      metadata: { channel: { name: 'room' } },
    });
  });

  it('still stops acknowledging a channel on a genuine unsubscribe with no rejoin queued', async () => {
    const { socket, ws } = buildReceived();
    const room = await subscribedReceived(socket, ws);

    ws.emit({
      event: 'msg',
      payload: { text: 'a' },
      metadata: { channel: { name: 'room' }, delivery: { seq: 5 } },
    });
    await flush();

    const leave = room.unsubscribe();
    const unsubscribeId = ws.sentFrames().at(-1).metadata.channel?.unsubscribeId;
    ws.emit({
      event: '__unsubscribeOk__',
      payload: {},
      metadata: { channel: { name: 'room', unsubscribeId: unsubscribeId } },
    });
    await leave;

    ws.emit({
      event: 'msg',
      payload: { text: 'b' },
      metadata: { channel: { name: 'room' }, delivery: { seq: 9 } },
    });
    await flush();

    expect(receivedFrames(ws)).toHaveLength(1);
  });

  it('still forgets the scope unconditionally on __kicked__ during a pending rejoin', async () => {
    const { socket, ws } = buildReceived();
    const room = await subscribedReceived(socket, ws);

    ws.emit({
      event: 'msg',
      payload: { text: 'a' },
      metadata: { channel: { name: 'room' }, delivery: { seq: 5 } },
    });
    await flush();

    const leave = room.unsubscribe();
    const staleUnsubscribeId = ws.sentFrames().at(-1).metadata.channel?.unsubscribeId;
    room.subscribe().catch(() => {});
    ws.emit({
      event: '__unsubscribeOk__',
      payload: {},
      metadata: { channel: { name: 'room', unsubscribeId: staleUnsubscribeId } },
    });
    await leave;

    ws.emit({
      event: '__kicked__',
      payload: { reason: 'bye' },
      metadata: { channel: { name: 'room' } },
    });

    ws.emit({
      event: 'msg',
      payload: { text: 'b' },
      metadata: { channel: { name: 'room' }, delivery: { seq: 9 } },
    });
    await flush();

    expect(receivedFrames(ws)).toHaveLength(1);
  });

  it('ignores an earlier leave ack while a newer leave is pending', async () => {
    const { socket, ws } = buildReceived();
    const room = await subscribedReceived(socket, ws);

    ws.emit({
      event: '__received__',
      payload: { userId: 'bob', receivedThrough: 5 },
      metadata: { channel: { name: 'room' } },
    });

    // Keep the first leave's receipt state through a queued rejoin. This is the
    // continuity window in which its confirmation is no longer actionable for
    // receipt cleanup, even though it matches the leave that was sent.
    const leave1 = room.unsubscribe();
    const leave1Id = ws.sentFrames().at(-1).metadata.channel?.unsubscribeId;
    const rejoin1 = room.subscribe();
    ws.emit({
      event: '__unsubscribeOk__',
      payload: {},
      metadata: { channel: { name: 'room', unsubscribeId: leave1Id } },
    });
    await leave1;

    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      metadata: { exchange: { source: 'client' }, channel: { name: 'room', inbox: true } },
    });
    await rejoin1;
    expect(room.receivers.get()).toEqual(new Map([['bob', 5]]));

    // A duplicate from the first leave is stale even while the channel is live.
    ws.emit({
      event: '__unsubscribeOk__',
      payload: {},
      metadata: { channel: { name: 'room', unsubscribeId: leave1Id } },
    });
    expect(room.receivers.get()).toEqual(new Map([['bob', 5]]));

    const leave2 = room.unsubscribe();
    const leave2Id = ws.sentFrames().at(-1).metadata.channel?.unsubscribeId;
    let leave2Settled = false;
    void leave2.then(() => {
      leave2Settled = true;
    });

    // The old confirmation must not clear state for the newer leave. A gap
    // arriving in the same reordered window still gets its inbox ack.
    ws.emit({
      event: '__unsubscribeOk__',
      payload: {},
      metadata: { channel: { name: 'room', unsubscribeId: leave1Id } },
    });
    await Promise.resolve();
    expect(leave2Settled).toBe(false);
    expect(room.receivers.get()).toEqual(new Map([['bob', 5]]));
    ws.emit({
      event: '__gap__',
      payload: { missedThrough: 20 },
      metadata: { channel: { name: 'room' } },
    });

    await flush();
    expect(receivedFrames(ws).at(-1)).toEqual({
      event: '__received__',
      payload: { receivedThrough: 20 },
      metadata: { channel: { name: 'room' } },
    });

    ws.emit({
      event: '__unsubscribeOk__',
      payload: {},
      metadata: { channel: { name: 'room', unsubscribeId: leave2Id } },
    });
    await leave2;
    expect(room.receivers.get()).toEqual(new Map());

    // Once the active leave is confirmed, a later gap is no longer in an
    // inbox scope and must not create a new acknowledgement.
    ws.emit({
      event: '__gap__',
      payload: { missedThrough: 30 },
      metadata: { channel: { name: 'room' } },
    });
    await flush();
    expect(receivedFrames(ws)).not.toContainEqual({
      event: '__received__',
      payload: { receivedThrough: 30 },
      metadata: { channel: { name: 'room' } },
    });
  });

  it('clears preserved state when a queued rejoin payload fails', async () => {
    const { socket, ws } = buildReceived();
    const room = await subscribedReceived(socket, ws);

    ws.emit({
      event: '__received__',
      payload: { userId: 'bob', receivedThrough: 5 },
      metadata: { channel: { name: 'room' } },
    });

    const leave = room.unsubscribe();
    const unsubscribeId = ws.sentFrames().at(-1).metadata.channel?.unsubscribeId;
    const error = new Error('rejoin payload failed');
    const rejoin = room.subscribe(() => {
      throw error;
    });

    ws.emit({
      event: '__unsubscribeOk__',
      payload: {},
      metadata: { channel: { name: 'room', unsubscribeId: unsubscribeId } },
    });

    await expect(leave).resolves.toBeUndefined();
    await expect(rejoin).rejects.toBe(error);
    expect(room.receivers.get()).toEqual(new Map());

    ws.emit({
      event: '__gap__',
      payload: { missedThrough: 9 },
      metadata: { channel: { name: 'room' } },
    });
    await flush();
    expect(receivedFrames(ws)).not.toContainEqual({
      event: '__received__',
      payload: { receivedThrough: 9 },
      metadata: { channel: { name: 'room' } },
    });
  });
});
