import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type {
  ConnectionDescriptor,
  ConnectionHandle,
  UpgradeDecision,
} from '@wskit/server/adapters';
import type { RawData, WebSocket } from 'ws';
import { createWebSocketBridge } from './socket.ts';

class FakeWebSocket extends EventEmitter {
  bufferedAmount = 17;
  readonly send = vi.fn();
  readonly close = vi.fn();
}

function fakeSocket(): WebSocket {
  return new FakeWebSocket() as unknown as WebSocket;
}

function emitMessage(socket: WebSocket, data: RawData, isBinary: boolean): void {
  socket.emit('message', data, isBinary);
}

function createConnectionHandle(): {
  handle: ConnectionHandle;
  calls: {
    messages: string[];
    closes: Array<[number, string]>;
    errors: unknown[];
  };
} {
  const calls = { messages: [], closes: [], errors: [] } as {
    messages: string[];
    closes: Array<[number, string]>;
    errors: unknown[];
  };
  const handle: ConnectionHandle = {
    handleMessage: vi.fn(async (data: string) => {
      calls.messages.push(data);
    }),
    handleClose: vi.fn(async (code: number, reason: string) => {
      calls.closes.push([code, reason]);
    }),
    handleError: vi.fn(async (error: unknown) => {
      calls.errors.push(error);
    }),
  };
  return { handle, calls };
}

function createBridgeFixture(decision: UpgradeDecision = { userId: 'user-1' }) {
  const socket = fakeSocket();
  const connection = createConnectionHandle();
  let descriptor: ConnectionDescriptor | undefined;
  const engine = {
    accept: vi.fn((_socket: unknown, acceptedDescriptor: ConnectionDescriptor) => {
      descriptor = acceptedDescriptor;
      return connection.handle;
    }),
  };

  createWebSocketBridge({ engine, socket, decision });

  return { socket, connection, descriptor, engine };
}

describe('createWebSocketBridge', () => {
  it('builds the descriptor the engine uses to reach the socket', () => {
    const tags = [
      { __wskit: 'tag-ref' as const, kind: 'ephemeral' as const, group: 'team', key: 'red' },
    ];
    const meta = { role: 'admin' };
    const { socket, descriptor, engine } = createBridgeFixture({
      userId: 'user-1',
      meta,
      tags,
    });

    expect(engine.accept).toHaveBeenCalledWith(socket, descriptor);
    expect(descriptor).toBeDefined();
    expect(descriptor?.userId).toBe('user-1');
    expect(descriptor?.meta).toBe(meta);
    expect(descriptor?.tags).toBe(tags);
    expect(descriptor?.backpressureSupported).toBe(true);

    descriptor?.send('outgoing');
    descriptor?.close(4000, 'done');
    expect((socket as unknown as FakeWebSocket).send).toHaveBeenCalledWith('outgoing');
    expect((socket as unknown as FakeWebSocket).close).toHaveBeenCalledWith(4000, 'done');
    expect(descriptor?.bufferedAmount()).toBe(17);
  });

  it('converts text raw data to strings and forwards messages', () => {
    const { socket, connection } = createBridgeFixture();

    emitMessage(socket, Buffer.from('buffer text'), false);
    emitMessage(socket, new Uint8Array(Buffer.from('array buffer text')).buffer, false);
    emitMessage(socket, [Buffer.from('array '), Buffer.from('text')], false);

    expect(connection.calls.messages).toEqual(['buffer text', 'array buffer text', 'array text']);
  });

  it('closes binary messages with code 1003', () => {
    const { socket, connection } = createBridgeFixture();

    emitMessage(socket, Buffer.from([1, 2, 3]), true);

    expect((socket as unknown as FakeWebSocket).close).toHaveBeenCalledWith(
      1003,
      '[wskit] binary frames are not supported yet',
    );
    expect(connection.calls.messages).toEqual([]);
  });

  it('forwards close and error events to the engine handle', () => {
    const { socket, connection } = createBridgeFixture();
    const error = new Error('socket failed');

    socket.emit('close', 1001, Buffer.from('going away'));
    socket.emit('error', error);

    expect(connection.calls.closes).toEqual([[1001, 'going away']]);
    expect(connection.calls.errors).toEqual([error]);
  });

  it('does not serialize concurrent message handling', () => {
    const socket = fakeSocket();
    const first = Promise.resolve();
    const handleMessage = vi.fn(() => first);
    const handle: ConnectionHandle = {
      handleMessage,
      handleClose: vi.fn(async () => {}),
      handleError: vi.fn(async () => {}),
    };
    const engine = { accept: vi.fn(() => handle) };

    createWebSocketBridge({ engine, socket, decision: { userId: '' } });
    emitMessage(socket, Buffer.from('first'), false);
    emitMessage(socket, Buffer.from('second'), false);

    expect(handleMessage).toHaveBeenNthCalledWith(1, 'first');
    expect(handleMessage).toHaveBeenNthCalledWith(2, 'second');
  });
});
