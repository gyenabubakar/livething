import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { channels } from '~/primitives/channels/index.ts';
import { dedup } from '~/primitives/dedup.ts';
import { inbox } from '~/primitives/inbox/inbox.ts';
import { reconnection } from '~/primitives/reconnection/index.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
