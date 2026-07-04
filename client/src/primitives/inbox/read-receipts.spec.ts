import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { channels } from '~/primitives/channels/index.ts';
import { dedup } from '~/primitives/dedup.ts';
import { inbox } from '~/primitives/inbox/inbox.ts';
import { readReceipts } from '~/primitives/inbox/read-receipts.ts';
import { requestResponse } from '~/primitives/request-response/index.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

describe('read-receipts — markSeen default uses ownReceived', () => {
  it('sends __seen__ with the highest non-stream seq received when no seq is given', async () => {
    const { socket, ws } = build();
    const room = await subscribed(socket, ws);

    ws.emit({ event: 'msg', payload: { text: 'a' }, __wskit: { channel: 'room', seq: 8 } });
    room.markSeen();

    expect(ws.sentFrames().at(-1)).toEqual({
      event: '__seen__',
      payload: { seenThrough: 8 },
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
    room.markSeen();

    expect(ws.sentFrames().at(-1).payload).toEqual({ seenThrough: 4 });
  });

  it('resets ownReceived after a leave so a rejoin markSeen does not target the old mark', async () => {
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
    rejoined.markSeen();

    expect(ws.sentFrames().at(-1).payload).toEqual({ seenThrough: 5 });
  });
});

describe('read-receipts — seenBy query over __receiptQuery__', () => {
  function lastQuery(ws: MockWebSocket) {
    return ws
      .sentFrames()
      .filter((f) => f.event === '__receiptQuery__')
      .at(-1);
  }

  it('sends kind:seen and drops non-string identities from the result', async () => {
    const { socket, ws } = build();
    const room = await subscribed(socket, ws);

    const promise = room.seenBy(2);
    const query = lastQuery(ws);
    expect(query.payload.kind).toBe('seen');
    ws.emit({
      event: '__receiptQuery__',
      payload: { identities: ['alice', 7, null, 'carol'] },
      __wskit: { channel: 'room', correlationId: query.__wskit.correlationId },
    });

    await expect(promise).resolves.toEqual(['alice', 'carol']);
  });

  it('honours the factory default timeout when no per-call override is given', async () => {
    vi.useFakeTimers();
    const { socket, ws } = build({ timeout: 300 });
    const room = await subscribed(socket, ws);

    const promise = room.seenBy(1);
    const rejection = expect(promise).rejects.toMatchObject({ code: 'timeout' });
    vi.advanceTimersByTime(301);
    await rejection;
  });

  it('rejects a pending seenBy with Disconnected when the socket closes', async () => {
    const { socket, ws } = build();
    const room = await subscribed(socket, ws);

    const promise = room.seenBy(5);
    socket.disconnect();

    await expect(promise).rejects.toMatchObject({ code: 'disconnected' });
  });
});

describe('read-receipts — disjoint query ownership with inbox', () => {
  it('inbox owns the received query and read-receipts owns the seen query', async () => {
    const { socket, ws } = build();
    const room = await subscribed(socket, ws);

    // A received query is owned by inbox (which runs first); a seen query by
    // read-receipts. Their correlationIds are disjoint, so each resolves only
    // its own answer.
    const received = room.receivedBy(1);
    const seen = room.seenBy(1);
    const queries = ws.sentFrames().filter((f) => f.event === '__receiptQuery__');
    const receivedId = queries.find((q) => q.payload.kind === 'received').__wskit.correlationId;
    const seenId = queries.find((q) => q.payload.kind === 'seen').__wskit.correlationId;
    expect(receivedId).not.toBe(seenId);

    ws.emit({
      event: '__receiptQuery__',
      payload: { identities: ['seen-answer'] },
      __wskit: { channel: 'room', correlationId: seenId },
    });
    ws.emit({
      event: '__receiptQuery__',
      payload: { identities: ['received-answer'] },
      __wskit: { channel: 'room', correlationId: receivedId },
    });

    await expect(received).resolves.toEqual(['received-answer']);
    await expect(seen).resolves.toEqual(['seen-answer']);
  });

  it('resolves a seen query even though request-response runs first', async () => {
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

    const promise = room.seenBy(5);
    const query = ws
      .sentFrames()
      .filter((f) => f.event === '__receiptQuery__')
      .at(-1);
    ws.emit({
      event: '__receiptQuery__',
      payload: { identities: ['alice'] },
      __wskit: { channel: 'room', correlationId: query.__wskit.correlationId },
    });

    await expect(promise).resolves.toEqual(['alice']);
  });
});
