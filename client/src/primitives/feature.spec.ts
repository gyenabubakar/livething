import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { ack } from '~/primitives/ack/index.ts';
import { dedup } from '~/primitives/dedup.ts';
import { reconnection } from '~/primitives/reconnection/index.ts';
import { replay } from '~/primitives/replay.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface C {
  incoming: { msg: { text: string }; trade: { id: string } };
  outgoing: { chat: { text: string } };
  requests: {
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

function buildAck() {
  const socket = client<C>()(connect('wss://test'), ack());
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

describe('ack', () => {
  it('resolves when the server acknowledges', async () => {
    const { socket, ws } = buildAck();
    const promise = socket.sendWithAck('chat', { text: 'hi' });
    const ackId = ws.sentFrames().at(-1).__wskit.ackId;
    expect(typeof ackId).toBe('string');
    ws.emit({ event: '__ack__', payload: {}, __wskit: { ackId } });
    await expect(promise).resolves.toBeUndefined();
  });

  it('rejects with a typed error frame', async () => {
    const { socket, ws } = buildAck();
    const promise = socket.sendWithAck('chat', { text: 'hi' });
    const ackId = ws.sentFrames().at(-1).__wskit.ackId;
    ws.emit({ event: '__error__', payload: { code: 'rate-limited' }, __wskit: { ackId } });
    await expect(promise).rejects.toMatchObject({ code: 'rate-limited' });
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

      vi.advanceTimersByTime(1500); // let the backoff fire and reopen
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
