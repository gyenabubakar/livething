import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { ack } from '~/primitives/ack/index.ts';
import { buffering } from '~/primitives/buffering/index.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrimitiveHelpers } from '~/internal/runtime.ts';
import type { Primitive } from '~/primitives/types.ts';
import type { WSKitSocket } from '~/socket/socket.ts';

interface C {
  outgoing: { chat: { text: string } };
}

function build(primitive: ReturnType<typeof ack> = ack()) {
  const socket = client<C>()(connect('wss://test'), primitive);
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
  vi.useRealTimers();
});

describe('ack — buffered frame ownership', () => {
  it('does not send a timed-out ack after reconnect', async () => {
    vi.useFakeTimers();
    const socket = client<C>()(
      connect('wss://test'),
      buffering({ enabled: true }),
      ack({ timeout: 4000 }),
    );
    socket.connect();
    let ws = MockWebSocket.last();
    ws.open();
    ws.serverClose(1006);

    const settled = vi.fn();
    socket.sendWithAck('chat', { text: 'hi' }).then(
      () => settled('resolved'),
      (e: { code?: string }) => settled(e?.code),
    );

    vi.advanceTimersByTime(4000);
    await Promise.resolve();
    expect(settled).toHaveBeenCalledWith('timeout');

    socket.connect();
    ws = MockWebSocket.last();
    ws.open();
    expect(ws.sentFrames().some((f) => f.event === 'chat')).toBe(false);
  });

  it('rejects the exact ack whose held frame cannot serialize on flush, later acks still flush', async () => {
    const socket = client<C>()(connect('wss://test', { lazy: true }), ack());
    socket.onError(() => undefined); // absorb the reported serialization failure
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const bad = socket.sendWithAck('chat', circular as unknown as { text: string });
    const good = socket.sendWithAck('chat', { text: 'b' });
    void bad.catch(() => undefined);

    const ws = MockWebSocket.last();
    ws.open();

    await expect(bad).rejects.toBeInstanceOf(TypeError);
    const ackId = ws.sentFrames().at(-1).__wskit.ackId;
    ws.emit({ event: 'chat', payload: {}, __wskit: { ackId } });
    await expect(good).resolves.toBeUndefined();
  });
});

describe('ack — reserved event names', () => {
  it('rejects a reserved event name locally with validation-failed and no send', async () => {
    const { socket, ws } = build();
    const sendWithAck = socket.sendWithAck as (e: string, p: unknown) => Promise<void>;
    for (const name of ['ping', 'pong', '__error__']) {
      await expect(sendWithAck(name, { text: 'x' })).rejects.toMatchObject({
        code: 'validation-failed',
      });
    }
    expect(ws.sentFrames()).toHaveLength(0);
  });
});

describe('ack timeout and disconnect rejection', () => {
  it('rejects with Timeout when no ack arrives within the timeout', async () => {
    vi.useFakeTimers();
    const { socket } = build(ack({ timeout: 2000 }));
    const promise = socket.sendWithAck('chat', { text: 'hello' });
    const assertion = expect(promise).rejects.toMatchObject({ code: 'timeout' });
    vi.advanceTimersByTime(2000);
    await assertion;
  });

  it('uses a per-call timeout that overrides the primitive default', async () => {
    vi.useFakeTimers();
    const { socket } = build(ack({ timeout: 10_000 }));
    const promise = socket.sendWithAck('chat', { text: 'hello' }, { timeout: 500 });
    const assertion = expect(promise).rejects.toMatchObject({ code: 'timeout' });
    vi.advanceTimersByTime(500);
    await assertion;
  });

  it('rejects in-flight sendWithAck with Disconnected when socket disconnects', async () => {
    const { socket } = build();
    const promise = socket.sendWithAck('chat', { text: 'hello' });
    socket.disconnect();
    await expect(promise).rejects.toMatchObject({ code: 'disconnected' });
  });

  it('rejects all concurrent in-flight acks with Disconnected on disconnect', async () => {
    const { socket } = build();
    const first = socket.sendWithAck('chat', { text: 'a' });
    const second = socket.sendWithAck('chat', { text: 'b' });
    socket.disconnect();
    await expect(first).rejects.toMatchObject({ code: 'disconnected' });
    await expect(second).rejects.toMatchObject({ code: 'disconnected' });
  });

  it('recovers for a fresh ack after a disconnect rejected an in-flight one', async () => {
    const { socket } = build();
    const first = socket.sendWithAck('chat', { text: 'hi' });
    socket.disconnect();
    await expect(first).rejects.toMatchObject({ code: 'disconnected' });

    // After reconnect a brand-new ack resolves on its own __ack__, unaffected by
    // the rejected attempt (its id and waiter are independent).
    socket.connect();
    const ws2 = MockWebSocket.last();
    ws2.open();
    const second = socket.sendWithAck('chat', { text: 'again' });
    const ackId2 = ws2.sentFrames().at(-1).__wskit.ackId;
    ws2.emit({ event: '__ack__', payload: {}, __wskit: { ackId: ackId2 } });
    await expect(second).resolves.toBeUndefined();
  });
});

describe('ack stale/duplicate frame handling', () => {
  it('a stale __ack__ frame (no matching waiter) must be swallowed, not forwarded to user handlers', () => {
    const { socket, ws } = build();
    const handler = vi.fn();
    (socket as unknown as { on(event: string, handler: (data: unknown) => void): () => void }).on(
      '__ack__',
      handler,
    );

    // Emit an __ack__ frame with an ackId that has no registered waiter.
    ws.emit({ event: '__ack__', payload: {}, __wskit: { ackId: 'stale-id-that-never-existed' } });

    expect(handler).not.toHaveBeenCalled();
  });
});

describe('ack lazy-socket hold', () => {
  it('holds a sendWithAck started on a connecting lazy socket and resolves it once open and acked', async () => {
    // Lazy socket (idleTimeout=0 so no idle timer fires), no buffering.
    const socket = client<C>()(
      connect('wss://test', { lazy: true, idleTimeout: 0 }),
      ack({ timeout: 5000 }),
    );

    const rawSocket = socket as unknown as { _lazyConsumers: number };
    expect(rawSocket._lazyConsumers).toBe(0);

    // sendWithAck triggers the lazy connect (socket enters 'connecting'). With no
    // buffering the frame is held for the in-progress connect, not dropped, and
    // the hold stays until the ack settles.
    const pending = socket.sendWithAck('chat', { text: 'hi' });
    void pending.catch(() => undefined);
    expect(rawSocket._lazyConsumers).toBe(1);

    const ws = MockWebSocket.last(); // created by the lazy connect, not open yet
    expect(ws.sentFrames()).toEqual([]); // held while connecting

    ws.open(); // onOpen flushes the held frame
    const frame = ws.sentFrames().at(-1);
    expect(frame.event).toBe('chat');

    ws.emit({ event: '__ack__', payload: {}, __wskit: { ackId: frame.__wskit.ackId } });
    await expect(pending).resolves.toBeUndefined();
    expect(rawSocket._lazyConsumers).toBe(0); // hold released after it settles
  });
});

describe('ack ttl option passthrough', () => {
  it('includes ttl in the send options when callOptions.ttl is set', () => {
    const { socket, ws } = build();
    const sendSpy = vi.spyOn(socket as unknown as WSKitSocket, '_send');
    const promise = socket.sendWithAck('chat', { text: 'hi' }, { ttl: 5000 });
    // helpers.send delegates to socket._send — verify the options arg carries the ttl
    // (alongside the owner attached so a buffered/outboxed ack can be settled).
    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'chat' }),
      expect.objectContaining({ ttl: 5000, owner: expect.any(Object) }),
    );
    const frame = ws.sentFrames().at(-1);
    ws.emit({ event: '__ack__', payload: {}, __wskit: { ackId: frame.__wskit.ackId } });
    return expect(promise).resolves.toBeUndefined();
  });

  it('omits ttl from send options when callOptions.ttl is undefined', () => {
    const { socket, ws } = build();
    const sendSpy = vi.spyOn(socket as unknown as WSKitSocket, '_send');
    const promise = socket.sendWithAck('chat', { text: 'hi' });
    // helpers.send delegates to socket._send — with no ttl the options still carry
    // the owner attached so a buffered/outboxed ack can be settled.
    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'chat' }),
      expect.objectContaining({ owner: expect.any(Object) }),
    );
    const frame = ws.sentFrames().at(-1);
    ws.emit({ event: '__ack__', payload: {}, __wskit: { ackId: frame.__wskit.ackId } });
    return expect(promise).resolves.toBeUndefined();
  });

  it('forwards ttl to the outgoing fallback when the socket is not connected', async () => {
    vi.useFakeTimers();

    // Build with a custom outgoing fallback that records the ttl it receives.
    // We achieve this by registering a primitive that captures helpers.send calls.
    // Simplest approach: spy on the actual wire using a disconnected socket
    // and a buffering primitive implemented inline.
    let capturedTtl: number | undefined = 'not-called' as unknown as number | undefined;

    const fakePrimitive = {
      _tag: 'fake-buffer' as const,
      setup(helpers: PrimitiveHelpers) {
        helpers.registerOutgoingFallback((_message, options) => {
          capturedTtl = options?.ttl;
          return true;
        });
        return { id: 'fake-buffer' };
      },
    };

    const socket = client<C>()(connect('wss://test'), ack(), fakePrimitive as unknown as Primitive);
    // Do NOT connect so sends hit the fallback
    socket.sendWithAck('chat', { text: 'hi' }, { ttl: 3000 });

    expect(capturedTtl).toBe(3000);
  });

  it('passes undefined ttl to the outgoing fallback when ttl is not supplied', async () => {
    vi.useFakeTimers();

    let capturedTtl: number | undefined = 999 as number | undefined;

    const fakePrimitive = {
      _tag: 'fake-buffer' as const,
      setup(helpers: PrimitiveHelpers) {
        helpers.registerOutgoingFallback((_message, options) => {
          capturedTtl = options?.ttl;
          return true;
        });
        return { id: 'fake-buffer' };
      },
    };

    const socket = client<C>()(connect('wss://test'), ack(), fakePrimitive as unknown as Primitive);
    socket.sendWithAck('chat', { text: 'hi' });

    expect(capturedTtl).toBeUndefined();
  });
});
