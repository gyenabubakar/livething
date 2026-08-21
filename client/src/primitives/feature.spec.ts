import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { dedup } from '~/primitives/dedup.ts';
import { reconnection } from '~/primitives/reconnection/index.ts';
import { replay } from '~/primitives/replay.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface C {
  incoming: { msg: { text: string }; trade: { id: string } };
  outgoing: { chat: { text: string } };
  clientRequests: {
    'get-balance': { payload: { user: string }; response: { balance: number } };
  };
}

function buildDedup() {
  const socket = client<C>()(connect('wss://test'), dedup());
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

describe('dedup', () => {
  it('drops a message whose id was already seen', () => {
    const { socket, ws } = buildDedup();
    const handler = vi.fn();
    socket.on('trade', handler);
    ws.emit({ event: 'trade', payload: { id: 'a' }, __wskit: { messageId: 'm1' } });
    ws.emit({ event: 'trade', payload: { id: 'a' }, __wskit: { messageId: 'm1' } });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('always delivers messages with no id', () => {
    const { socket, ws } = buildDedup();
    const handler = vi.fn();
    socket.on('trade', handler);
    ws.emit({ event: 'trade', payload: { id: 'a' } });
    ws.emit({ event: 'trade', payload: { id: 'a' } });
    expect(handler).toHaveBeenCalledTimes(2);
  });
});

describe('replay', () => {
  it('requires dedup', () => {
    expect(() => client<C>()(connect('wss://test'), replay())).toThrow(/replay requires dedup/);
  });

  it('asks the server to catch up after a reconnect', () => {
    vi.useFakeTimers();
    try {
      const socket = client<C>()(connect('wss://test'), dedup(), replay(), reconnection());
      socket.connect();
      const first = MockWebSocket.last();
      first.open();
      first.emit({ event: 'msg', payload: { text: 'a' }, __wskit: { seq: 5 } });
      first.serverClose(1006, 'dropped');

      vi.advanceTimersByTime(1500);
      const second = MockWebSocket.last();
      expect(second).not.toBe(first);
      second.open();

      expect(second.sentFrames()).toContainEqual({
        event: '__replay__',
        payload: { lastKnownSeq: 5 },
        __wskit: {},
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
