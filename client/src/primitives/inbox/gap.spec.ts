import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { channels } from '~/primitives/channels/index.ts';
import { dedup } from '~/primitives/dedup.ts';
import { gaps } from '~/primitives/gaps.ts';
import { inbox } from '~/primitives/inbox/inbox.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GapInfo } from '~/types.ts';

interface C {
  channels: {
    room: {
      incoming: { msg: { text: string } };
      outgoing: { chat: { text: string } };
    };
  };
}

let restore: () => void;
beforeEach(() => {
  restore = installMockWebSocket();
});
afterEach(() => {
  restore();
  vi.useRealTimers();
});

describe('protocol frame leak guard (no gaps)', () => {
  it('does not deliver a top-level __gap__ to a user socket.on() handler', () => {
    const socket = client<C>()(connect('wss://test'), channels(), dedup(), inbox());
    socket.connect();
    const ws = MockWebSocket.last();
    ws.open();
    const onMessage = vi.fn();
    // A user could subscribe to the reserved name; the frame must still be dropped.
    (socket as unknown as { on(e: string, h: () => void): void }).on('__gap__', onMessage);

    ws.emit({ event: '__gap__', payload: { missedThrough: 5 }, metadata: null });

    expect(onMessage).not.toHaveBeenCalled();
  });
});

describe('inbox overflow gap surfacing', () => {
  it('routes a channel-scoped overflow __gap__ to channel.onGap when gaps() is installed', () => {
    const socket = client<C>()(connect('wss://test'), channels(), dedup(), inbox(), gaps());
    socket.connect();
    const ws = MockWebSocket.last();
    ws.open();
    const roomGap: GapInfo[] = [];

    const socketGap: GapInfo[] = [];
    socket.channel('room').onGap((info) => roomGap.push(info));
    socket.onGap((info) => socketGap.push(info));

    ws.emit({
      event: '__gap__',
      payload: { missedThrough: 7 },
      metadata: { channel: { name: 'room' } },
    });

    expect(roomGap).toEqual([{ missedThrough: 7, channel: 'room' }]);
    expect(socketGap).toEqual([]);
  });

  it('routes a family-channel overflow __gap__ to that channel handle keyed by family + name', () => {
    interface FamilyC {
      channels: {
        rooms: {
          addressing: 'dynamic';
          incoming: { msg: { text: string } };
          outgoing: { chat: { text: string } };
        };
      };
    }

    const socket = client<FamilyC>()(connect('wss://test'), channels(), dedup(), inbox(), gaps());
    socket.connect();
    const ws = MockWebSocket.last();
    ws.open();

    const roomGap: GapInfo[] = [];
    socket.channel('rooms', 'room-1').onGap((info) => roomGap.push(info));

    ws.emit({
      event: '__gap__',
      payload: { missedThrough: 9 },
      metadata: { channel: { name: 'room-1', family: 'rooms' } },
    });

    expect(roomGap).toEqual([{ missedThrough: 9, channel: 'room-1', channelFamily: 'rooms' }]);
  });

  it('drops a channel-scoped overflow __gap__ on an inbox-only client without gaps()', () => {
    const socket = client<C>()(connect('wss://test'), channels(), dedup(), inbox());
    socket.connect();
    const ws = MockWebSocket.last();
    ws.open();
    const onMessage = vi.fn();

    socket.channel('room').on('__gap__' as never, onMessage);

    // No gap listener exists, and reserved frames never reach application handlers.
    ws.emit({
      event: '__gap__',
      payload: { missedThrough: 7 },
      metadata: { channel: { name: 'room' } },
    });

    expect(onMessage).not.toHaveBeenCalled();
  });
});

/** Flush the inbox primitive's queued-microtask ack. */
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

function receivedFrames(ws: MockWebSocket) {
  return ws.sentFrames().filter((f) => f.event === '__received__');
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

describe('inbox — acknowledging an overflow gap', () => {
  it('acks a gap when gaps() is registered before inbox()', async () => {
    const socket = client<C>()(connect('wss://test'), channels(), dedup(), gaps(), inbox());
    socket.connect();
    const ws = MockWebSocket.last();
    ws.open();
    subscribeOk(ws, 'room', true);

    ws.emit({
      event: '__gap__',
      payload: { missedThrough: 12 },
      metadata: { channel: { name: 'room' } },
    });
    await flush();

    expect(receivedFrames(ws)).toEqual([
      {
        event: '__received__',
        payload: { receivedThrough: 12 },
        metadata: { channel: { name: 'room' } },
      },
    ]);
  });

  it('acks a gap on an inbox channel with __received__ carrying the gap sequence', async () => {
    const socket = client<C>()(connect('wss://test'), channels(), dedup(), inbox(), gaps());
    socket.connect();
    const ws = MockWebSocket.last();
    ws.open();
    subscribeOk(ws, 'room', true);

    ws.emit({
      event: '__gap__',
      payload: { missedThrough: 12 },
      metadata: { channel: { name: 'room' } },
    });
    await flush();

    expect(receivedFrames(ws)).toEqual([
      {
        event: '__received__',
        payload: { receivedThrough: 12 },
        metadata: { channel: { name: 'room' } },
      },
    ]);
  });

  it('does not ack a gap on a channel the client has not subscribed to with inbox', async () => {
    const socket = client<C>()(connect('wss://test'), channels(), dedup(), inbox(), gaps());
    socket.connect();
    const ws = MockWebSocket.last();
    ws.open();
    subscribeOk(ws, 'room', false);

    ws.emit({
      event: '__gap__',
      payload: { missedThrough: 12 },
      metadata: { channel: { name: 'room' } },
    });
    await flush();

    expect(receivedFrames(ws)).toEqual([]);
  });

  it('does not regress the ack when a gap arrives for a sequence already acknowledged', async () => {
    const socket = client<C>()(connect('wss://test'), channels(), dedup(), inbox(), gaps());
    socket.connect();
    const ws = MockWebSocket.last();
    ws.open();
    subscribeOk(ws, 'room', true);

    ws.emit({
      event: 'msg',
      payload: { text: 'a' },
      metadata: { channel: { name: 'room' }, delivery: { seq: 10 } },
    });
    await flush();
    expect(receivedFrames(ws)).toEqual([
      {
        event: '__received__',
        payload: { receivedThrough: 10 },
        metadata: { channel: { name: 'room' } },
      },
    ]);

    ws.emit({
      event: '__gap__',
      payload: { missedThrough: 5 },
      metadata: { channel: { name: 'room' } },
    });
    await flush();

    expect(receivedFrames(ws)).toEqual([
      {
        event: '__received__',
        payload: { receivedThrough: 10 },
        metadata: { channel: { name: 'room' } },
      },
    ]);
  });
});
