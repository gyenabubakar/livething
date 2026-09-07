import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { CloseCodes } from '@wskit/server/errors';
import { describe, expect, it, vi } from 'vitest';
import type { UpgradeDecision } from '@wskit/server/adapters';
import { createUpgradeHandler } from './upgrade.ts';
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

function fakeWebSocketServer(webSocket: { close: ReturnType<typeof vi.fn> }): NodeWebSocketServer {
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

describe('createUpgradeHandler', () => {
  it('passes an accepted decision to the socket callback after the handshake', async () => {
    const webSocket = { close: vi.fn() };
    const webSocketServer = fakeWebSocketServer(webSocket);
    const decision: UpgradeDecision = { userId: 'user-1' };
    const handleUpgrade = vi.fn(async () => decision);
    const onAccepted = vi.fn();

    const request = incomingRequest();
    const socket = fakeSocket();
    const head = Buffer.from('head');

    await createUpgradeHandler({
      engine: { handleUpgrade },
      onAccepted,
      webSocketServer,
    })(request, socket, head);

    expect(handleUpgrade).toHaveBeenCalledWith(expect.any(Request));
    expect(webSocketServer.handleUpgrade).toHaveBeenCalledWith(
      request,
      socket,
      head,
      expect.any(Function),
    );
    expect(onAccepted).toHaveBeenCalledWith(webSocket, request, decision);
  });

  it('passes the resolved client IP to the engine request', async () => {
    const request = incomingRequest();
    Object.defineProperty(request.socket, 'remoteAddress', {
      configurable: true,
      value: '203.0.113.7',
    });
    const handleUpgrade = vi.fn(async () => ({ userId: 'user-1' }));

    await createUpgradeHandler({
      engine: { handleUpgrade },
      onAccepted: vi.fn(),
      clientIp: { mode: 'direct' },
      webSocketServer: fakeWebSocketServer({ close: vi.fn() }),
    })(request, fakeSocket(), Buffer.alloc(0));

    const firstCall = handleUpgrade.mock.calls[0] as [Request] | undefined;
    const webRequest = firstCall?.[0];
    expect(webRequest?.headers.get('WSKit-Client-IP')).toBe('203.0.113.7');
  });

  it('writes an HTTP rejection for an HTTP status decision', async () => {
    const socket = fakeSocket();

    await createUpgradeHandler({
      engine: {
        handleUpgrade: vi.fn(async () => ({ reject: true, code: 401, reason: 'No token' })),
      },
      onAccepted: vi.fn(),
      webSocketServer: fakeWebSocketServer({ close: vi.fn() }),
    })(incomingRequest(), socket, Buffer.alloc(0));

    const response = (socket as { end: ReturnType<typeof vi.fn> }).end.mock.calls[0]?.[0] as Buffer;
    expect(response.toString()).toContain('HTTP/1.1 401 Unauthorized');
    expect(response.toString()).toContain('Content-Length: 8');
    expect(response.toString()).toMatch(/No token$/);
  });

  it('completes the handshake and closes for a WebSocket close decision', async () => {
    const webSocket = { close: vi.fn() };
    const webSocketServer = fakeWebSocketServer(webSocket);

    await createUpgradeHandler({
      engine: {
        handleUpgrade: vi.fn(async () => ({
          reject: true,
          code: CloseCodes.AUTH_INVALID,
          reason: 'Invalid token',
        })),
      },
      onAccepted: vi.fn(),
      webSocketServer,
    })(incomingRequest(), fakeSocket(), Buffer.alloc(0));

    expect(webSocket.close).toHaveBeenCalledWith(CloseCodes.AUTH_INVALID, 'Invalid token');
  });

  it('limits an oversized WebSocket close reason to the protocol byte limit', async () => {
    const webSocket = { close: vi.fn() };
    const reason = '🙂'.repeat(100);

    await createUpgradeHandler({
      engine: {
        handleUpgrade: vi.fn(async () => ({
          reject: true,
          code: CloseCodes.AUTH_INVALID,
          reason,
        })),
      },
      onAccepted: vi.fn(),
      webSocketServer: fakeWebSocketServer(webSocket),
    })(incomingRequest(), fakeSocket(), Buffer.alloc(0));

    const limitedReason = webSocket.close.mock.calls[0]?.[1] as string;
    expect(Buffer.byteLength(limitedReason, 'utf8')).toBeLessThanOrEqual(123);
    expect(limitedReason).toBe('🙂'.repeat(30));
  });
});
