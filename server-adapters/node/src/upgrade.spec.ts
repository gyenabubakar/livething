import { EventEmitter } from 'node:events';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { CloseCodes } from '@wskit/server/errors';
import { describe, expect, it, vi } from 'vitest';
import { createNodeUpgradeHandler } from './upgrade.ts';
import type {
  NodeAcceptedUpgrade,
  NodeBindingEndpoint,
  NodeConnection,
  NodeUpgrade,
} from './binding.ts';
import type { NodeWebSocketServer } from './upgrade.ts';

function incomingRequest(
  values: Partial<Pick<IncomingMessage, 'url' | 'method' | 'headers'>> = {},
): IncomingMessage {
  const socket = new Socket();
  return Object.assign(new IncomingMessage(socket), {
    url: '/socket?room=one',
    method: 'GET',
    ...values,
    headers: {
      host: 'example.test',
      connection: 'Upgrade',
      upgrade: 'websocket',
      ...values.headers,
    },
  });
}

function fakeWebSocketServer(webSocket: unknown): NodeWebSocketServer {
  return {
    handleUpgrade: vi.fn((...args: Parameters<NodeWebSocketServer['handleUpgrade']>) => {
      args[3](webSocket as never, incomingRequest());
    }),
  };
}

function fakeSocket() {
  return {
    destroyed: false,
    end: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
  } as never;
}

function fakeEndpoint(upgrade: NodeUpgrade): NodeBindingEndpoint {
  return {
    ready: () => Promise.resolve(),
    prepare: vi.fn(async () => upgrade),
    prepareNode: vi.fn(async () => upgrade),
    admin: vi.fn(async () => ({}) as never),
  };
}

function acceptedUpgrade(connection: NodeConnection): NodeAcceptedUpgrade {
  return {
    type: 'accept',
    accept: vi.fn(() => connection),
  };
}

describe('createNodeUpgradeHandler', () => {
  it('prepares before the handshake, then attaches the accepted transport', async () => {
    const connection: NodeConnection = {
      message: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      error: vi.fn(async () => {}),
    };

    const upgrade = acceptedUpgrade(connection);
    const endpoint = fakeEndpoint(upgrade);
    const webSocket = { close: vi.fn(), on: vi.fn(), send: vi.fn(), bufferedAmount: 0 };
    const webSocketServer = fakeWebSocketServer(webSocket);

    const request = incomingRequest();
    const socket = fakeSocket();

    createNodeUpgradeHandler({ endpoint, webSocketServer })(request, socket, Buffer.from('head'));

    await vi.waitFor(() => expect(webSocketServer.handleUpgrade).toHaveBeenCalledOnce());
    expect(endpoint.prepareNode).toHaveBeenCalledWith(request, { signal: expect.any(AbortSignal) });
    expect(upgrade.accept).toHaveBeenCalledOnce();
    expect(webSocket.on).toHaveBeenCalledTimes(3);
  });

  it('forwards text, binary, close, and error events from an accepted socket', async () => {
    const connection: NodeConnection = {
      message: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      error: vi.fn(async () => {}),
    };

    const endpoint = fakeEndpoint(acceptedUpgrade(connection));
    const webSocket = Object.assign(new EventEmitter(), {
      bufferedAmount: 0,
      close: vi.fn(),
      send: vi.fn(),
    });

    createNodeUpgradeHandler({ endpoint, webSocketServer: fakeWebSocketServer(webSocket) })(
      incomingRequest(),
      fakeSocket(),
      Buffer.alloc(0),
    );

    await vi.waitFor(() => expect(webSocket.listenerCount('message')).toBe(1));
    webSocket.emit('message', Buffer.from('hello'), false);
    webSocket.emit('message', Buffer.from([1]), true);
    webSocket.emit('close', 1001, Buffer.from('going away'));
    const error = new Error('socket failed');

    webSocket.emit('error', error);

    expect(connection.message).toHaveBeenCalledWith('hello');
    expect(webSocket.close).toHaveBeenCalledWith(
      1003,
      '[wskit] binary frames are not supported yet',
    );
    expect(connection.close).toHaveBeenCalledWith(1001, 'going away');
    expect(connection.error).toHaveBeenCalledWith(error);
  });

  it('writes a prepared HTTP response without starting a WebSocket handshake', async () => {
    const endpoint = fakeEndpoint({
      type: 'http',
      response: new Response('No token', {
        status: 401,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      }),
    });
    const socket = fakeSocket();
    const webSocketServer = fakeWebSocketServer({ close: vi.fn(), on: vi.fn() });

    createNodeUpgradeHandler({ endpoint, webSocketServer })(
      incomingRequest(),
      socket,
      Buffer.alloc(0),
    );

    const end = (socket as unknown as { end: ReturnType<typeof vi.fn> }).end;
    await vi.waitFor(() => expect(end).toHaveBeenCalledOnce());
    const response = end.mock.calls[0]?.[0] as Buffer;
    expect(response.toString()).toContain('HTTP/1.1 401 Unauthorized');
    expect(response.toString()).toContain('content-length: 8');

    expect(response.toString()).toMatch(/No token$/);
    expect(webSocketServer.handleUpgrade).not.toHaveBeenCalled();
  });

  it('completes the handshake and closes for a prepared socket rejection', async () => {
    const endpoint = fakeEndpoint({
      type: 'socket',
      code: CloseCodes.AUTH_INVALID,
      reason: 'Invalid token',
    });
    const webSocket = { close: vi.fn(), on: vi.fn() };

    createNodeUpgradeHandler({ endpoint, webSocketServer: fakeWebSocketServer(webSocket) })(
      incomingRequest(),
      fakeSocket(),
      Buffer.alloc(0),
    );

    await vi.waitFor(() => {
      expect(webSocket.close).toHaveBeenCalledWith(CloseCodes.AUTH_INVALID, 'Invalid token');
    });
  });

  it('limits an oversized prepared close reason to the protocol byte limit', async () => {
    const reason = '🙂'.repeat(100);
    const endpoint = fakeEndpoint({ type: 'socket', code: CloseCodes.AUTH_INVALID, reason });
    const webSocket = { close: vi.fn(), on: vi.fn() };

    createNodeUpgradeHandler({ endpoint, webSocketServer: fakeWebSocketServer(webSocket) })(
      incomingRequest(),
      fakeSocket(),
      Buffer.alloc(0),
    );

    await vi.waitFor(() => expect(webSocket.close).toHaveBeenCalledOnce());
    const limitedReason = webSocket.close.mock.calls[0]?.[1] as string;
    expect(Buffer.byteLength(limitedReason, 'utf8')).toBeLessThanOrEqual(123);
    expect(limitedReason).toBe('🙂'.repeat(30));
  });
});
