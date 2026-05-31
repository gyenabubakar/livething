import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface TestContract {
  incoming: { message: { text: string }; notification: { id: string } };
  outgoing: { 'mark-read': { notificationId: string }; typing: { channelId: string } };
}

/** Build a connected test socket and return it with its mock WebSocket. */
function connected(opts?: { lazy?: boolean }) {
  const socket = client<TestContract>()(connect('wss://test', opts));
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

describe('client() composition', () => {
  it('throws on duplicate primitive tags', () => {
    expect(() => client<TestContract>()(connect('wss://a'), connect('wss://b'))).toThrow(
      /duplicate connect/,
    );
  });

  it('throws when a primitive dependency is missing', () => {
    const needsDedup = { _tag: 'replay-fake', dependencies: ['dedup'] };
    expect(() => client<TestContract>()(connect('wss://a'), needsDedup)).toThrow(
      /replay-fake requires dedup\. Register dedup\(\) in client\./,
    );
  });
});

describe('connection lifecycle', () => {
  it('starts closed and transitions to open on connect', () => {
    const socket = client<TestContract>()(connect('wss://test'));
    expect(socket.getState()).toBe('closed');
    socket.connect();
    expect(socket.getState()).toBe('connecting');
    MockWebSocket.last().open();
    expect(socket.getState()).toBe('open');
  });

  it('notifies subscribers on state change', () => {
    const socket = client<TestContract>()(connect('wss://test'));
    const seen: string[] = [];
    socket.subscribe(() => seen.push(socket.getState()));
    socket.connect();
    MockWebSocket.last().open();
    expect(seen).toEqual(['connecting', 'open']);
  });

  it('disconnect() closes with the given code and goes to closed', () => {
    const { socket, ws } = connected();
    socket.disconnect(4001, 'auth expired');
    expect(ws.readyState).toBe(3);
    expect(socket.getState()).toBe('closed');
  });

  it('connect() is idempotent while open', () => {
    const { socket } = connected();
    socket.connect();
    expect(MockWebSocket.instances).toHaveLength(1);
  });
});

describe('messaging (__wskit wire format)', () => {
  it('dispatches incoming events to on() handlers', () => {
    const { socket, ws } = connected();
    const handler = vi.fn();
    socket.on('message', handler);
    ws.emit({ event: 'message', payload: { text: 'hi' } });
    expect(handler).toHaveBeenCalledWith({ text: 'hi' });
  });

  it('serializes send() as { event, payload }', () => {
    const { socket, ws } = connected();
    const ok = socket.send('mark-read', { notificationId: '7' });
    expect(ok).toBe(true);
    expect(ws.sentFrames()).toContainEqual({
      event: 'mark-read',
      payload: { notificationId: '7' },
    });
  });

  it('returns false when sending while disconnected (no buffering)', () => {
    const socket = client<TestContract>()(connect('wss://test'));
    expect(socket.send('typing', { channelId: 'a' })).toBe(false);
  });

  it('auto-answers server ping with pong and never dispatches it', () => {
    const { ws } = connected();
    ws.emit({ event: 'ping', payload: {} });
    expect(ws.sentFrames()).toContainEqual({ event: 'pong', payload: {} });
  });

  it('does not dispatch protocol pong to handlers', () => {
    const { socket, ws } = connected();
    const handler = vi.fn();
    socket.on('message', handler);
    ws.emit({ event: 'pong', payload: {} });
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('lazy connection', () => {
  it('does not connect until a listener is added', () => {
    const socket = client<TestContract>()(connect('wss://test', { lazy: true }));
    expect(MockWebSocket.instances).toHaveLength(0);
    socket.on('message', () => {});
    expect(MockWebSocket.instances).toHaveLength(1);
  });
});
