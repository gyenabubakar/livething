import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { ack } from '~/primitives/ack/index.ts';
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

describe('ack ttl option passthrough', () => {
  it('includes ttl in the send options when callOptions.ttl is set', () => {
    const { socket, ws } = build();
    const sendSpy = vi.spyOn(socket as unknown as WSKitSocket, '_send');
    const promise = socket.sendWithAck('chat', { text: 'hi' }, { ttl: 5000 });
    // helpers.send delegates to socket._send — verify the options arg carries the ttl
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ event: 'chat' }), { ttl: 5000 });
    const frame = ws.sentFrames().at(-1);
    ws.emit({ event: '__ack__', payload: {}, __wskit: { ackId: frame.__wskit.ackId } });
    return expect(promise).resolves.toBeUndefined();
  });

  it('omits ttl from send options when callOptions.ttl is undefined', () => {
    const { socket, ws } = build();
    const sendSpy = vi.spyOn(socket as unknown as WSKitSocket, '_send');
    const promise = socket.sendWithAck('chat', { text: 'hi' });
    // helpers.send delegates to socket._send — verify no options arg is passed when ttl is absent
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ event: 'chat' }), undefined);
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
        helpers.registerOutgoingFallback((_message, ttl?: number) => {
          capturedTtl = ttl;
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
        helpers.registerOutgoingFallback((_message, ttl?: number) => {
          capturedTtl = ttl;
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
