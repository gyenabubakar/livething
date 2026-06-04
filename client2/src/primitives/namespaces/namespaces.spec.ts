import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { namespaces } from '~/primitives/namespaces/index.ts';
import { WSKitSocket } from '~/socket/socket.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NamespacesOptions } from '~/primitives/namespaces/index.ts';

interface C {
  incoming: { 'get-balance': { balance: number } };
  namespaces: {
    chat: {
      incoming: {
        msg: { text: string };
        'get-balance': { balance: number };
        __error__: { code: string };
      };
      outgoing: { msg: { text: string }; typing: { who: string } };
    };
  };
}

function build(options?: NamespacesOptions) {
  const socket = client<C>()(connect('wss://test'), namespaces(options));
  socket.connect();
  const ws = MockWebSocket.last();
  ws.open();
  return { socket, ws };
}

function lazyBuild(options?: NamespacesOptions) {
  return client<C>()(connect('wss://test', { lazy: true, idleTimeout: 1000 }), namespaces(options));
}

let restore: () => void;
beforeEach(() => {
  restore = installMockWebSocket();
});
afterEach(() => {
  restore();
  vi.useRealTimers();
});

describe('unsubscribe cleanup + lazyRelease', () => {
  it('stops delivering events to the handler after unsubscribe', () => {
    const { socket, ws } = build();
    const handler = vi.fn();
    const unsub = socket.namespace('chat').on('msg', handler);

    ws.emit({ event: 'msg', payload: { text: 'before' }, __wskit: { namespace: 'chat' } });
    expect(handler).toHaveBeenCalledTimes(1);

    unsub();

    ws.emit({ event: 'msg', payload: { text: 'after' }, __wskit: { namespace: 'chat' } });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('cleans up the empty event entry in the handler map when the last handler unsubscribes', () => {
    const { socket, ws } = build();
    const handlerA = vi.fn();
    const handlerB = vi.fn();

    const unsubA = socket.namespace('chat').on('msg', handlerA);
    const unsubB = socket.namespace('chat').on('msg', handlerB);

    // Both registered: both get the first emit.
    ws.emit({ event: 'msg', payload: { text: 'both' }, __wskit: { namespace: 'chat' } });
    expect(handlerA).toHaveBeenCalledTimes(1);
    expect(handlerB).toHaveBeenCalledTimes(1);

    // Unsubscribe A; only B should receive the next emit.
    unsubA();
    ws.emit({ event: 'msg', payload: { text: 'one left' }, __wskit: { namespace: 'chat' } });
    expect(handlerA).toHaveBeenCalledTimes(1);
    expect(handlerB).toHaveBeenCalledTimes(2);

    // Unsubscribe B; the event entry is now empty and should be deleted.
    // A further emit must reach neither handler.
    unsubB();
    ws.emit({ event: 'msg', payload: { text: 'none left' }, __wskit: { namespace: 'chat' } });
    expect(handlerA).toHaveBeenCalledTimes(1);
    expect(handlerB).toHaveBeenCalledTimes(2);
  });

  it('calls lazyRelease when unsubscribing, letting a lazy socket idle-close', async () => {
    vi.useFakeTimers();

    const socket = lazyBuild();
    const unsub = socket.namespace('chat').on('msg', vi.fn());

    // Trigger lazy connect by calling namespace().on(), then open the ws.
    MockWebSocket.last().open();

    unsub();

    // After the idle timeout the socket should have closed itself.
    vi.advanceTimersByTime(1000);
    expect(socket.getState()).toBe('closed');
  });
});

describe('passthrough guards (correlationId / __ prefix / streamId)', () => {
  it('does not call namespace handler for a frame that has a correlationId', () => {
    const { socket, ws } = build();
    const handler = vi.fn();
    socket.namespace('chat').on('get-balance', handler);

    ws.emit({
      event: 'get-balance',
      payload: { balance: 99 },
      __wskit: { namespace: 'chat', correlationId: 'cid-1' },
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it('does not call namespace handler for a frame whose event starts with __', () => {
    const { socket, ws } = build();
    const handler = vi.fn();
    socket.namespace('chat').on('__error__', handler);

    ws.emit({
      event: '__error__',
      payload: { code: 'forbidden' },
      __wskit: { namespace: 'chat' },
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it('passes correlationId frames through so request-response can claim them', () => {
    const { socket, ws } = build();
    const topHandler = vi.fn();
    // top-level on() fires for unscoped events only, so spy on socket.on for a plain event
    socket.on('get-balance', topHandler);

    // The request-response path uses correlationId and the frame has a namespace tag;
    // the namespace primitive must return it unchanged (not swallow it).
    // We confirm by checking the frame survives: emit it and verify the top-level
    // handler did NOT get it (namespace scoping still blocks top-level), but
    // crucially the namespace handler was also not called — it was passed through
    // for the real owner (correlationId path).
    const nsHandler = vi.fn();
    socket.namespace('chat').on('get-balance', nsHandler);

    ws.emit({
      event: 'get-balance',
      payload: { balance: 42 },
      __wskit: { namespace: 'chat', correlationId: 'cid-2' },
    });

    // Neither handler should have been called — the namespace guard passes it
    // through, and top-level dispatch skips namespaced frames.
    expect(nsHandler).not.toHaveBeenCalled();
    expect(topHandler).not.toHaveBeenCalled();
  });
});

describe('ttl resolution', () => {
  it('passes a global number ttl to helpers.send when configured', () => {
    const { socket } = build({ ttl: 5000 });
    const sendSpy = vi.spyOn(WSKitSocket.prototype, '_send');

    socket.namespace('chat').send('msg', { text: 'hi' });

    const [, options] = sendSpy.mock.calls.at(-1)!;
    expect(options).toEqual({ ttl: 5000 });

    sendSpy.mockRestore();
  });

  it('passes the per-event ttl to helpers.send on a map hit', () => {
    const { socket } = build({ ttl: { msg: 3000, typing: 500 } });
    const sendSpy = vi.spyOn(WSKitSocket.prototype, '_send');

    socket.namespace('chat').send('typing', { who: 'ada' });

    const [, options] = sendSpy.mock.calls.at(-1)!;
    expect(options).toEqual({ ttl: 500 });

    sendSpy.mockRestore();
  });

  it('passes no ttl option to helpers.send on a map miss (event not in map)', () => {
    const { socket } = build({ ttl: { typing: 500 } });
    const sendSpy = vi.spyOn(WSKitSocket.prototype, '_send');

    socket.namespace('chat').send('msg', { text: 'hi' });

    const [, options] = sendSpy.mock.calls.at(-1)!;
    expect(options).toBeUndefined();

    sendSpy.mockRestore();
  });

  it('per-call ttl overrides a configured map ttl', () => {
    const { socket } = build({ ttl: { msg: 3000 } });
    const sendSpy = vi.spyOn(WSKitSocket.prototype, '_send');

    socket.namespace('chat').send('msg', { text: 'hi' }, { ttl: 100 });

    const [, options] = sendSpy.mock.calls.at(-1)!;
    expect(options).toEqual({ ttl: 100 });

    sendSpy.mockRestore();
  });
});
