/* oxlint-disable @typescript-eslint/no-explicit-any -- install adds onRequest/request dynamically */
import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { requestResponse } from '~/primitives/request-response/index.ts';
import { serverRequest } from '~/primitives/server-request/index.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

interface C {
  requests: { 'get-balance': { payload: { user: string }; response: { balance: number } } };
  serverRequests: {
    'ask-permission': { payload: { action: string }; response: { allowed: boolean } };
  };
}

function build() {
  const socket = client<C>()(connect('wss://test'), requestResponse(), serverRequest());
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

describe('serverRequest — answering server-initiated requests', () => {
  it('runs the handler and replies echoing the correlationId', async () => {
    const { socket, ws } = build();
    (socket as any).onRequest('ask-permission', (payload: { action: string }) => ({
      allowed: payload.action === 'read',
    }));

    ws.emit({
      event: 'ask-permission',
      payload: { action: 'read' },
      __wskit: { correlationId: 'x1' },
    });
    await new Promise((r) => setTimeout(r, 0));

    const reply = ws.sentFrames().find((f) => f.event === 'ask-permission');
    expect(reply).toMatchObject({ payload: { allowed: true }, __wskit: { correlationId: 'x1' } });
  });

  it('replies with a request-no-response error frame when the handler throws', async () => {
    const { socket, ws } = build();
    (socket as any).onRequest('ask-permission', () => {
      throw new Error('boom');
    });

    ws.emit({
      event: 'ask-permission',
      payload: { action: 'x' },
      __wskit: { correlationId: 'x2' },
    });
    await new Promise((r) => setTimeout(r, 0));

    const reply = ws.sentFrames().find((f) => f.event === '__error__');
    expect(reply).toMatchObject({
      payload: { code: 'request-no-response' },
      __wskit: { correlationId: 'x2' },
    });
  });

  it("does not consume a reply to the client's own request", async () => {
    const { socket, ws } = build();
    const handlerHits: unknown[] = [];
    (socket as any).onRequest('ask-permission', (p: unknown) => {
      handlerHits.push(p);
      return { allowed: true };
    });

    const pending = (socket as any).request('get-balance', { user: 'a' });
    const reqFrame = ws.sentFrames().find((f) => f.event === 'get-balance');
    const correlationId = reqFrame.__wskit.correlationId;

    ws.emit({ event: 'get-balance', payload: { balance: 5 }, __wskit: { correlationId } });
    await expect(pending).resolves.toEqual({ balance: 5 });
    expect(handlerHits).toHaveLength(0);
  });

  it('echoes channel markers on the reply', async () => {
    const { socket, ws } = build();
    (socket as any).onRequest('ask-permission', () => ({ allowed: true }));

    ws.emit({
      event: 'ask-permission',
      payload: { action: 'x' },
      __wskit: { correlationId: 'x3', channel: 'room-1', channelScope: 'rooms' },
    });
    await new Promise((r) => setTimeout(r, 0));

    const reply = ws.sentFrames().find((f) => f.event === 'ask-permission');
    expect(reply.__wskit).toMatchObject({
      correlationId: 'x3',
      channel: 'room-1',
      channelScope: 'rooms',
    });
  });
});
