import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { channels } from '~/primitives/channels/index.ts';
import { dedup } from '~/primitives/dedup.ts';
import { inbox } from '~/primitives/inbox/inbox.ts';
import { receipts } from '~/primitives/inbox/receipts.ts';
import { requestResponse } from '~/primitives/request-response/index.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelReceipt } from '~/primitives/inbox/types.ts';

interface C {
  channels: {
    room: {
      receipts: true;
      incoming: { msg: { text: string } };
      outgoing: { chat: { text: string } };
    };
  };
}

function build(receiptsOptions?: { timeout?: number }) {
  const socket = client<C>()(
    connect('wss://test'),
    channels(),
    dedup(),
    inbox(),
    receipts(receiptsOptions),
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
    __wskit: { source: 'client', channel: 'room', inbox: true },
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

describe('receipts — live store from __receipt__', () => {
  it('updates the reactive store and fires onReceipt with a Math.max merge', async () => {
    const { socket, ws } = build();
    const room = await subscribed(socket, ws);
    const seen: ChannelReceipt[] = [];
    room.onReceipt((r) => seen.push(r));

    ws.emit({
      event: '__receipt__',
      payload: { identity: 'bob', receivedThrough: 5 },
      __wskit: { channel: 'room' },
    });
    ws.emit({
      event: '__receipt__',
      payload: { identity: 'bob', seenThrough: 3 },
      __wskit: { channel: 'room' },
    });

    expect(seen.at(-1)).toEqual({ identity: 'bob', receivedThrough: 5, seenThrough: 3 });
    expect(room.receipts.get().get('bob')).toEqual({
      identity: 'bob',
      receivedThrough: 5,
      seenThrough: 3,
    });
  });

  it('ignores a __receipt__ with a non-string identity', async () => {
    const { socket, ws } = build();
    const room = await subscribed(socket, ws);
    ws.emit({
      event: '__receipt__',
      payload: { identity: 42, receivedThrough: 5 },
      __wskit: { channel: 'room' },
    });
    expect(room.receipts.get().size).toBe(0);
  });
});

describe('receipts — markSeen default uses ownReceived', () => {
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

describe('receipts — async queries over __receiptQuery__', () => {
  function lastQuery(ws: MockWebSocket) {
    return ws
      .sentFrames()
      .filter((f) => f.event === '__receiptQuery__')
      .at(-1);
  }

  it('resolves receivedBy with the server identities, matched by correlationId on the same event', async () => {
    const { socket, ws } = build();
    const room = await subscribed(socket, ws);

    const promise = room.receipts.receivedBy(5);
    const query = lastQuery(ws);
    expect(query.payload).toEqual({ seq: 5, kind: 'received' });
    const correlationId = query.__wskit.correlationId;

    ws.emit({
      event: '__receiptQuery__',
      payload: { identities: ['alice', 'bob'] },
      __wskit: { channel: 'room', correlationId },
    });

    await expect(promise).resolves.toEqual(['alice', 'bob']);
  });

  it('seenBy sends kind:seen and drops non-string identities from the result', async () => {
    const { socket, ws } = build();
    const room = await subscribed(socket, ws);

    const promise = room.receipts.seenBy(2);
    const query = lastQuery(ws);
    expect(query.payload.kind).toBe('seen');
    ws.emit({
      event: '__receiptQuery__',
      payload: { identities: ['alice', 7, null, 'carol'] },
      __wskit: { channel: 'room', correlationId: query.__wskit.correlationId },
    });

    await expect(promise).resolves.toEqual(['alice', 'carol']);
  });

  it('rejects with Timeout after the per-call timeout and cleans up', async () => {
    vi.useFakeTimers();
    const { socket, ws } = build();
    const room = await subscribed(socket, ws);

    const promise = room.receipts.receivedBy(5, { timeout: 200 });
    const rejection = expect(promise).rejects.toMatchObject({ code: 'timeout' });
    vi.advanceTimersByTime(201);
    await rejection;

    // A late reply after timeout is ignored (no unhandled resolution).
    const query = ws
      .sentFrames()
      .filter((f) => f.event === '__receiptQuery__')
      .at(-1);
    ws.emit({
      event: '__receiptQuery__',
      payload: { identities: ['alice'] },
      __wskit: { channel: 'room', correlationId: query.__wskit.correlationId },
    });
  });

  it('honours the factory default timeout when no per-call override is given', async () => {
    vi.useFakeTimers();
    const { socket, ws } = build({ timeout: 300 });
    const room = await subscribed(socket, ws);

    const promise = room.receipts.seenBy(1);
    const rejection = expect(promise).rejects.toMatchObject({ code: 'timeout' });
    vi.advanceTimersByTime(301);
    await rejection;
  });

  it('rejects every pending query with Disconnected when the socket closes', async () => {
    const { socket, ws } = build();
    const room = await subscribed(socket, ws);

    const promise = room.receipts.receivedBy(5);
    socket.disconnect();

    await expect(promise).rejects.toMatchObject({ code: 'disconnected' });
  });
});

describe('receipts — passthrough alongside request-response', () => {
  function buildWithRequests() {
    const socket = client<C>()(
      connect('wss://test'),
      requestResponse(),
      channels(),
      dedup(),
      inbox(),
      receipts(),
    );
    socket.connect();
    const ws = MockWebSocket.last();
    ws.open();
    return { socket, ws };
  }

  it('resolves a receipt query even though request-response runs first (it forwards the unmatched frame)', async () => {
    const { socket, ws } = buildWithRequests();
    const room = await subscribed(socket, ws);

    const promise = room.receipts.receivedBy(5);
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

  it('drops a stale __error__ for an unknown correlationId — request-response owns and swallows it', async () => {
    const { socket, ws } = buildWithRequests();
    await subscribed(socket, ws);
    const onError = vi.fn();
    socket.onError(onError);

    // A correlated __error__ belongs to request-response; with no matching
    // waiter it is dropped, never surfaced as a global error or a query result.
    ws.emit({
      event: '__error__',
      payload: { code: 'validation-failed' },
      __wskit: { correlationId: 'never-sent' },
    });

    expect(onError).not.toHaveBeenCalled();
  });
});
