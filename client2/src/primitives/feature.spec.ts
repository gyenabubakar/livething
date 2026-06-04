import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { ack } from '~/primitives/ack/index.ts';
import { dedup } from '~/primitives/dedup.ts';
import { namespaces } from '~/primitives/namespaces/index.ts';
import { reconnection } from '~/primitives/reconnection/index.ts';
import { replay } from '~/primitives/replay.ts';
import { requestResponse } from '~/primitives/request-response/index.ts';
import { stream } from '~/primitives/stream/index.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface C {
  incoming: { msg: { text: string }; trade: { id: string } };
  outgoing: { chat: { text: string } };
  namespaces: {
    alerts: {
      incoming: { alert: { n: number }; feed: { token: string } };
      outgoing: { dismiss: { id: string } };
    };
  };
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

function buildRequestResponse(options?: Parameters<typeof requestResponse>[0]) {
  const socket = client<C>()(connect('wss://test'), requestResponse(options));
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

function buildNamespaces() {
  const socket = client<C>()(connect('wss://test'), namespaces());
  socket.connect();
  const ws = MockWebSocket.last();
  ws.open();
  return { socket, ws };
}

function buildNamespacesStream() {
  const socket = client<C>()(connect('wss://test'), namespaces(), stream());
  socket.connect();
  const ws = MockWebSocket.last();
  ws.open();
  return { socket, ws };
}

function buildNamespacesAck() {
  const socket = client<C>()(connect('wss://test'), namespaces(), ack());
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

describe('requestResponse', () => {
  it('resolves with the matching response', async () => {
    const { socket, ws } = buildRequestResponse();
    const promise = socket.request('get-balance', { user: 'a' });
    const cid = ws.sentFrames().at(-1).__wskit.correlationId;
    expect(typeof cid).toBe('string');
    ws.emit({ event: 'get-balance', payload: { balance: 10 }, __wskit: { correlationId: cid } });
    await expect(promise).resolves.toEqual({ balance: 10 });
  });

  it('rejects with a typed error frame', async () => {
    const { socket, ws } = buildRequestResponse();
    const promise = socket.request('get-balance', { user: 'a' });
    const cid = ws.sentFrames().at(-1).__wskit.correlationId;
    ws.emit({
      event: '__error__',
      payload: { code: 'forbidden', detail: { reason: 'no' } },
      __wskit: { correlationId: cid },
    });
    await expect(promise).rejects.toMatchObject({ code: 'forbidden', detail: { reason: 'no' } });
  });

  it('rejects with Disconnected when disconnected while waiting', async () => {
    const { socket } = buildRequestResponse();
    const promise = socket.request('get-balance', { user: 'a' });
    socket.disconnect();
    await expect(promise).rejects.toMatchObject({ code: 'disconnected' });
  });

  it('rejects with Timeout when no reply arrives', async () => {
    vi.useFakeTimers();
    try {
      const { socket } = buildRequestResponse({ timeout: 1000 });
      const promise = socket.request('get-balance', { user: 'a' });
      const assertion = expect(promise).rejects.toMatchObject({ code: 'timeout' });
      vi.advanceTimersByTime(1000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
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

describe('namespaces', () => {
  it('routes namespaced events to namespace handlers only', () => {
    const { socket, ws } = buildNamespaces();
    const nsHandler = vi.fn();
    const topHandler = vi.fn();
    socket.namespace('alerts').on('alert', nsHandler);
    socket.on('msg', topHandler);
    ws.emit({ event: 'alert', payload: { n: 1 }, __wskit: { namespace: 'alerts' } });
    expect(nsHandler).toHaveBeenCalledWith({ n: 1 });
    expect(topHandler).not.toHaveBeenCalled();
  });

  it('tags namespace sends with __wskit.namespace', () => {
    const { socket, ws } = buildNamespaces();
    socket.namespace('alerts').send('dismiss', { id: '7' });
    expect(ws.sentFrames().at(-1)).toEqual({
      event: 'dismiss',
      payload: { id: '7' },
      __wskit: { namespace: 'alerts' },
    });
  });

  it('returns the same endpoint object for the same name', () => {
    const { socket } = buildNamespaces();
    expect(socket.namespace('alerts')).toBe(socket.namespace('alerts'));
  });

  it('does not deliver a namespace-scoped stream chunk to namespace.on()', () => {
    const { socket, ws } = buildNamespacesStream();
    const nsHandler = vi.fn();
    socket.namespace('alerts').on('feed', nsHandler);
    ws.emit({
      event: 'feed',
      payload: { token: 'a' },
      __wskit: { namespace: 'alerts', streamId: 's1', seq: 1 },
    });
    expect(nsHandler).not.toHaveBeenCalled();
  });

  it('adds scoped sendWithAck when ack is registered', async () => {
    const { socket, ws } = buildNamespacesAck();
    const promise = socket.namespace('alerts').sendWithAck('dismiss', { id: '7' });
    const frame = ws.sentFrames().at(-1);
    expect(frame.__wskit.namespace).toBe('alerts');
    expect(typeof frame.__wskit.ackId).toBe('string');
    ws.emit({ event: '__ack__', payload: {}, __wskit: { ackId: frame.__wskit.ackId } });
    await expect(promise).resolves.toBeUndefined();
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
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
