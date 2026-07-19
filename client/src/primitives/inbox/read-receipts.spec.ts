import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { channels } from '~/primitives/channels/index.ts';
import { dedup } from '~/primitives/dedup.ts';
import { inbox } from '~/primitives/inbox/inbox.ts';
import { readReceipts } from '~/primitives/inbox/read-receipts.ts';
import { requestResponse } from '~/primitives/request-response/index.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CursorList } from '~/primitives/inbox/types.ts';

interface C {
  channels: {
    room: {
      inbox: true;
      readReceipts: true;
      incoming: { msg: { text: string } };
      outgoing: { chat: { text: string } };
    };
  };
}

function build(readReceiptsOptions?: { timeout?: number }) {
  const socket = client<C>()(
    connect('wss://test'),
    channels(),
    dedup(),
    inbox(),
    readReceipts(readReceiptsOptions),
  );
  socket.connect();
  const ws = MockWebSocket.last();
  ws.open();
  return { socket, ws };
}

async function subscribed(socket: ReturnType<typeof build>['socket'], ws: MockWebSocket) {
  const room = socket.channel('room');
  const p = room.subscribe();
  ws.emit({
    event: '__subscribeOk__',
    payload: {},
    __wskit: { source: 'client', channel: 'room', inbox: true, readReceipts: true },
  });
  await p;
  return room;
}

let restore: () => void;
beforeEach(() => {
  restore = installMockWebSocket();
});
afterEach(() => {
  restore();
  vi.useRealTimers();
});

describe('read-receipts — markAsRead default uses ownReceived', () => {
  it('sends __read__ with the highest non-stream seq received when no seq is given', async () => {
    const { socket, ws } = build();
    const room = await subscribed(socket, ws);

    ws.emit({ event: 'msg', payload: { text: 'a' }, __wskit: { channel: 'room', seq: 8 } });
    room.markAsRead();

    expect(ws.sentFrames().at(-1)).toEqual({
      event: '__read__',
      payload: { readThrough: 8 },
      __wskit: { channel: 'room' },
    });
  });

  it('does not advance ownReceived from a stream chunk', async () => {
    const { socket, ws } = build();
    const room = await subscribed(socket, ws);

    ws.emit({ event: 'msg', payload: { text: 'a' }, __wskit: { channel: 'room', seq: 4 } });
    ws.emit({
      event: 'tokens',
      payload: { text: 'x' },
      __wskit: { channel: 'room', streamId: 's-1', seq: 99 },
    });
    room.markAsRead();

    expect(ws.sentFrames().at(-1).payload).toEqual({ readThrough: 4 });
  });

  it('resets ownReceived after a leave so a rejoin markAsRead does not target the old mark', async () => {
    const { socket, ws } = build();
    const room = await subscribed(socket, ws);
    ws.emit({ event: 'msg', payload: { text: 'a' }, __wskit: { channel: 'room', seq: 50 } });

    const leave = room.unsubscribe();
    const unsubscribeId = ws.sentFrames().at(-1).__wskit.unsubscribeId;
    ws.emit({
      event: '__unsubscribeOk__',
      payload: {},
      __wskit: { channel: 'room', unsubscribeId },
    });
    await leave;

    const rejoined = await subscribed(socket, ws);
    ws.emit({ event: 'msg', payload: { text: 'b' }, __wskit: { channel: 'room', seq: 5 } });
    rejoined.markAsRead();

    expect(ws.sentFrames().at(-1).payload).toEqual({ readThrough: 5 });
  });
});

describe('read-receipts — readers store from __read__ fan-out', () => {
  it('updates the reactive store and fires onRead with a Math.max merge', async () => {
    const { socket, ws } = build();
    const room = await subscribed(socket, ws);
    const events: Array<[string, number]> = [];
    room.onRead((identity, readThrough) => events.push([identity, readThrough]));

    ws.emit({
      event: '__read__',
      payload: { userId: 'bob', readThrough: 5 },
      __wskit: { channel: 'room' },
    });
    ws.emit({
      event: '__read__',
      payload: { userId: 'bob', readThrough: 3 },
      __wskit: { channel: 'room' },
    });

    expect(events).toEqual([
      ['bob', 5],
      ['bob', 5],
    ]);
    expect(room.readers.get().get('bob')).toBe(5);
  });

  it('projects readThrough per member, dropping members still at 0', async () => {
    const { socket, ws } = build();
    const room = await subscribed(socket, ws);
    const snapshots: CursorList[] = [];
    room.readers.subscribe((v) => snapshots.push(v));

    ws.emit({
      event: '__read__',
      payload: { userId: 'bob', readThrough: 4 },
      __wskit: { channel: 'room' },
    });
    ws.emit({
      event: '__read__',
      payload: { userId: 'alice', readThrough: 2 },
      __wskit: { channel: 'room' },
    });

    expect(room.readers.get()).toEqual(
      new Map([
        ['bob', 4],
        ['alice', 2],
      ]),
    );
    expect(snapshots.at(-1)).toEqual(
      new Map([
        ['bob', 4],
        ['alice', 2],
      ]),
    );
  });

  it('clears the readers store on __unsubscribeOk__', async () => {
    const { socket, ws } = build();
    const room = await subscribed(socket, ws);
    ws.emit({
      event: '__read__',
      payload: { userId: 'bob', readThrough: 5 },
      __wskit: { channel: 'room' },
    });
    expect(room.readers.get().size).toBe(1);

    ws.emit({ event: '__unsubscribeOk__', payload: {}, __wskit: { channel: 'room' } });
    expect(room.readers.get().size).toBe(0);
  });
});

describe('read-receipts — readersOf query over __readQuery__', () => {
  function lastQuery(ws: MockWebSocket) {
    return ws
      .sentFrames()
      .filter((f) => f.event === '__readQuery__')
      .at(-1);
  }

  it('sends __readQuery__ and drops non-string identities from the result', async () => {
    const { socket, ws } = build();
    const room = await subscribed(socket, ws);

    const promise = room.readersOf(2);
    const query = lastQuery(ws);
    expect(query.payload).toEqual({ seq: 2 });
    ws.emit({
      event: '__readQuery__',
      payload: { userIds: ['alice', 7, null, 'carol'] },
      __wskit: { channel: 'room', correlationId: query.__wskit.correlationId },
    });

    await expect(promise).resolves.toEqual(['alice', 'carol']);
  });

  it('honours the factory default timeout when no per-call override is given', async () => {
    vi.useFakeTimers();
    const { socket, ws } = build({ timeout: 300 });
    const room = await subscribed(socket, ws);

    const promise = room.readersOf(1);
    const rejection = expect(promise).rejects.toMatchObject({ code: 'timeout' });
    vi.advanceTimersByTime(301);
    await rejection;
  });

  it('rejects a pending readersOf with Disconnected when the socket closes', async () => {
    const { socket, ws } = build();
    const room = await subscribed(socket, ws);

    const promise = room.readersOf(5);
    socket.disconnect();

    await expect(promise).rejects.toMatchObject({ code: 'disconnected' });
  });
});

describe('read-receipts — disjoint query ownership with inbox', () => {
  it('inbox owns the received query and read-receipts owns the read query', async () => {
    const { socket, ws } = build();
    const room = await subscribed(socket, ws);

    // A received query is owned by inbox (`__receivedQuery__`); a read query by
    // read-receipts (`__readQuery__`). Distinct events AND distinct
    // correlationIds, so each resolves only its own answer.
    const received = room.receiversOf(1);
    const read = room.readersOf(1);
    const receivedQuery = ws
      .sentFrames()
      .filter((f) => f.event === '__receivedQuery__')
      .at(-1);
    const readQuery = ws
      .sentFrames()
      .filter((f) => f.event === '__readQuery__')
      .at(-1);
    const receivedId = receivedQuery.__wskit.correlationId;
    const readId = readQuery.__wskit.correlationId;
    expect(receivedId).not.toBe(readId);

    ws.emit({
      event: '__readQuery__',
      payload: { userIds: ['read-answer'] },
      __wskit: { channel: 'room', correlationId: readId },
    });
    ws.emit({
      event: '__receivedQuery__',
      payload: { userIds: ['received-answer'] },
      __wskit: { channel: 'room', correlationId: receivedId },
    });

    await expect(received).resolves.toEqual(['received-answer']);
    await expect(read).resolves.toEqual(['read-answer']);
  });

  it('resolves a read query even though request-response runs first', async () => {
    const socket = client<C>()(
      connect('wss://test'),
      requestResponse(),
      channels(),
      dedup(),
      inbox(),
      readReceipts(),
    );
    socket.connect();
    const ws = MockWebSocket.last();
    ws.open();
    const room = await subscribed(socket, ws);

    const promise = room.readersOf(5);
    const query = ws
      .sentFrames()
      .filter((f) => f.event === '__readQuery__')
      .at(-1);
    ws.emit({
      event: '__readQuery__',
      payload: { userIds: ['alice'] },
      __wskit: { channel: 'room', correlationId: query.__wskit.correlationId },
    });

    await expect(promise).resolves.toEqual(['alice']);
  });
});
