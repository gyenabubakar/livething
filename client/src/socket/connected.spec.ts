import { LiveThingConfigError } from '@livething/core';
import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { reconnection } from '~/primitives/reconnection/index.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectedInfo } from '~/internal/runtime.ts';
import type { Primitive } from '~/primitives/types.ts';

const c = client();

let restore: () => void;
beforeEach(() => {
  restore = installMockWebSocket();
  vi.useFakeTimers();
});
afterEach(() => {
  restore();
  vi.useRealTimers();
});

/** A primitive that records the order of the hooks the socket runs. */
function hookLog() {
  const calls: string[] = [];
  const infos: ConnectedInfo[] = [];
  const primitive = {
    _tag: 'hook-log',
    setup: () => ({
      id: 'hook-log',
      onConnected(info: ConnectedInfo) {
        calls.push('onConnected');
        infos.push(info);
      },
      onOpen() {
        calls.push('onOpen');
        return null;
      },
      onReconnect() {
        calls.push('onReconnect');
        return null;
      },
    }),
  } as unknown as Primitive;

  return { primitive, calls, infos };
}

/** Every state the socket goes through. */
function statesOf(socket: { state: { subscribe(listener: (state: string) => void): unknown } }) {
  const states: string[] = [];
  socket.state.subscribe((state) => states.push(state));

  return states;
}

describe('the socket waits for __connected__', () => {
  it('stays connecting after the handshake, and opens when the frame arrives', () => {
    const socket = c(connect('wss://test'));
    const onOpen = vi.fn();
    socket.onOpen(onOpen);
    socket.connect();
    const ws = MockWebSocket.last();

    ws.open('', null);
    expect(socket.state.get()).toBe('connecting');
    expect(socket.transport.get()).toBeNull();
    expect(onOpen).not.toHaveBeenCalled();

    ws.connected();
    expect(socket.state.get()).toBe('open');
    expect(socket.transport.get()).toBe('websocket');
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('runs onConnected with the frame values before onOpen and onReconnect', () => {
    const log = hookLog();
    const socket = c(connect('wss://test'), reconnection(), log.primitive);
    socket.connect();
    MockWebSocket.last().open('', { connectionId: 'c_amara', pingIntervalMs: 20_000 });
    MockWebSocket.last().serverClose(1006, 'dropped');

    vi.advanceTimersByTime(1500);
    MockWebSocket.last().open();

    expect(log.calls).toEqual(['onConnected', 'onOpen', 'onConnected', 'onReconnect', 'onOpen']);
    expect(log.infos[0]).toEqual({
      pingIntervalMs: 20_000,
      idleTimeoutMs: null,
      maxResumeTokens: 8,
      connectionId: 'c_amara',
      features: ['replay', 'binary', 'uploads'],
      resume: null,
    });
  });

  it('drops a frame that arrives before __connected__', () => {
    const socket = client<{ incoming: { 'message-posted': { text: string } } }>()(
      connect('wss://test'),
    );
    const onMessage = vi.fn();
    socket.on('message-posted', onMessage);
    socket.connect();
    const ws = MockWebSocket.last();

    ws.open('', null);

    ws.emit(['message-posted', { text: 'too early' }, null]);
    ws.connected();
    ws.emit(['message-posted', { text: 'on time' }, null]);

    expect(onMessage.mock.calls).toEqual([[{ text: 'on time' }]]);
  });

  it('never shows open when the server closes before __connected__, as a rejected login does', () => {
    const socket = c(connect('wss://test'), reconnection());
    const states = statesOf(socket);
    const onClose = vi.fn();
    socket.onClose(onClose);
    socket.connect();

    const ws = MockWebSocket.last();

    ws.open('', null);
    ws.serverClose(4002, 'Authentication failed');

    expect(states).not.toContain('open');
    expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ code: 4002 }));
  });

  it('closes the transport and reports an error for a __connected__ frame it cannot read', () => {
    const socket = c(connect('wss://test'));
    const onError = vi.fn();
    const onClose = vi.fn();
    socket.onError(onError);
    socket.onClose(onClose);

    socket.connect();
    const ws = MockWebSocket.last();

    ws.open('', null);
    ws.emit(['__connected__', { connectionId: 42 }, null]);

    expect(ws.readyState).toBe(3);
    expect(socket.state.get()).toBe('closed');
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/cannot read/) }),
    );
    expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ code: 1002 }));
  });
});

describe('connectTimeoutMs', () => {
  it('gives up on a transport after 30 seconds by default, and retries', () => {
    const socket = c(connect('wss://test'), reconnection());
    const onError = vi.fn();
    socket.onError(onError);
    socket.connect();
    const ws = MockWebSocket.last();

    ws.open('', null);

    vi.advanceTimersByTime(29_999);
    expect(onError).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/within 30000 ms/) }),
    );
    expect(ws.readyState).toBe(3);
    expect(socket.state.get()).toBe('reconnecting');

    vi.advanceTimersByTime(1500);
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it('uses the connectTimeoutMs option, and ignores a late frame from the abandoned transport', () => {
    const socket = c(connect('wss://test', { connectTimeoutMs: 2_000 }), reconnection());
    socket.onError(() => {});
    const onOpen = vi.fn();
    socket.onOpen(onOpen);
    socket.connect();

    const ws = MockWebSocket.last();

    vi.advanceTimersByTime(2_000);
    ws.open();

    expect(onOpen).not.toHaveBeenCalled();
    expect(socket.state.get()).toBe('reconnecting');
  });

  it('stops the timer once the server accepts the connection', () => {
    const socket = c(connect('wss://test', { connectTimeoutMs: 2_000 }));
    const onError = vi.fn();
    socket.onError(onError);
    socket.connect();
    MockWebSocket.last().open();

    vi.advanceTimersByTime(10_000);

    expect(onError).not.toHaveBeenCalled();
    expect(socket.state.get()).toBe('open');
  });

  it.each([0, -1, Number.NaN, 2 ** 31])('refuses a connectTimeoutMs of %s', (connectTimeoutMs) => {
    expect(() => c(connect('wss://test', { connectTimeoutMs }))).toThrow(LiveThingConfigError);
  });
});
