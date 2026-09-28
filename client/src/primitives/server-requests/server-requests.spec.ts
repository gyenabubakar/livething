/* oxlint-disable @typescript-eslint/no-explicit-any -- install adds onRequest/request dynamically */
import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { channels } from '~/primitives/channels/index.ts';
import { clientRequests } from '~/primitives/client-requests/index.ts';
import { serverRequests } from '~/primitives/server-requests/index.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

interface C {
  clientRequests: { 'get-balance': { payload: { user: string }; response: { balance: number } } };
  serverRequests: {
    'ask-permission': { payload: { action: string }; response: { allowed: boolean } };
  };
  channels: {
    rooms: {
      addressing: 'dynamic';
      serverRequests: {
        'ask-permission': { payload: { action: string }; response: { allowed: boolean } };
      };
    };
  };
}

function build() {
  const socket = client<C>()(connect('wss://test'), clientRequests(), serverRequests(), channels());
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

describe('serverRequests — answering server-initiated requests', () => {
  it('runs the handler and replies echoing the correlationId', async () => {
    const { socket, ws } = build();
    (socket as any).onRequest('ask-permission', (payload: { action: string }) => ({
      allowed: payload.action === 'read',
    }));

    ws.emit({
      event: 'ask-permission',
      payload: { action: 'read' },
      metadata: { exchange: { id: 'x1', source: 'server' } },
    });
    await new Promise((r) => setTimeout(r, 0));

    const reply = ws.sentFrames().find((f) => f.event === 'ask-permission');
    expect(reply).toMatchObject({
      payload: { allowed: true },
      metadata: { exchange: { id: 'x1' } },
    });
  });

  it('replies with a request-no-response error frame when the handler throws', async () => {
    const { socket, ws } = build();
    (socket as any).onRequest('ask-permission', () => {
      throw new Error('boom');
    });

    ws.emit({
      event: 'ask-permission',
      payload: { action: 'x' },
      metadata: { exchange: { id: 'x2', source: 'server' } },
    });
    await new Promise((r) => setTimeout(r, 0));

    const reply = ws.sentFrames().find((f) => f.event === '__error__');
    expect(reply).toMatchObject({
      payload: { code: 'request-no-response' },
      metadata: { exchange: { id: 'x2' } },
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
    const correlationId = reqFrame.metadata.exchange?.id;

    ws.emit({
      event: 'get-balance',
      payload: { balance: 5 },
      metadata: { exchange: { id: correlationId } },
    });
    await expect(pending).resolves.toEqual({ balance: 5 });
    expect(handlerHits).toHaveLength(0);
  });

  it('replies with a null payload for a void acknowledgement handler', async () => {
    const { socket, ws } = build();
    const hits: unknown[] = [];
    (socket as any).onRequest('ack-me', (p: unknown) => {
      hits.push(p);
    });

    ws.emit({
      event: 'ack-me',
      payload: { action: 'commit' },
      metadata: { exchange: { id: 'ack1', source: 'server' } },
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(hits).toEqual([{ action: 'commit' }]);
    const reply = ws.sentFrames().find((f) => f.event === 'ack-me');
    expect(reply).toBeDefined();
    expect(reply?.metadata?.exchange?.id).toBe('ack1');
    expect(reply?.payload).toBeNull();

    expect(ws.sentFrames().some((f) => f.event === '__error__')).toBe(false);
  });

  it('turns a null wire payload into an undefined void response', async () => {
    const { socket, ws } = build();
    const pending = (socket as any).request('ack-thing', { go: true });
    const correlationId = ws.sentFrames().find((f) => f.event === 'ack-thing')?.metadata
      ?.exchange?.id;

    ws.emit({
      event: 'ack-thing',
      payload: null,
      metadata: { exchange: { id: correlationId } },
    });
    await expect(pending).resolves.toBeUndefined();
  });

  it('answers a channel-scoped request and echoes channel markers on the reply', async () => {
    const { socket, ws } = build();
    (socket as any).channel('rooms', 'room-1').onRequest('ask-permission', () => ({
      allowed: true,
    }));

    ws.emit({
      event: 'ask-permission',
      payload: { action: 'x' },
      metadata: {
        exchange: { id: 'x3', source: 'server' },
        channel: { name: 'room-1', family: 'rooms' },
      },
    });
    await new Promise((r) => setTimeout(r, 0));

    const reply = ws.sentFrames().find((f) => f.event === 'ask-permission');
    expect(reply.metadata).toMatchObject({
      exchange: { id: 'x3' },
      channel: { name: 'room-1', family: 'rooms' },
    });
  });

  it('does not let a channel onRequest answer a top-level request', async () => {
    const { socket, ws } = build();
    const hits: unknown[] = [];
    (socket as any).channel('rooms', 'room-1').onRequest('ask-permission', (p: unknown) => {
      hits.push(p);
      return { allowed: true };
    });

    // A server→client request with NO channel marker must not reach the channel
    // handler; with no top-level handler it fast-fails on the serverRequests flag.
    ws.emit({
      event: 'ask-permission',
      payload: { action: 'x' },
      metadata: { exchange: { id: 'x4', source: 'server' } },
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(hits).toHaveLength(0);
    const answer = ws.sentFrames().find((f) => f.event === 'ask-permission');
    expect(answer).toBeUndefined();
    const nak = ws.sentFrames().find((f) => f.event === '__error__');
    expect(nak).toMatchObject({
      payload: { code: 'request-no-response' },
      metadata: { exchange: { id: 'x4' } },
    });
  });

  it('does not let a top-level onRequest answer a channel-marked request', async () => {
    // Every server→client request is scoped to where it was declared: a channel
    // request carries channel markers, a top-level one does not. So a top-level
    // handler must not answer a channel-marked frame; with no channel handler it
    // fast-fails with request-no-response.
    const { socket, ws } = build();
    const hits: unknown[] = [];
    (socket as any).onRequest('ask-permission', (p: unknown) => {
      hits.push(p);
      return { allowed: true };
    });

    ws.emit({
      event: 'ask-permission',
      payload: { action: 'x' },
      metadata: {
        exchange: { id: 'x5', source: 'server' },
        channel: { name: 'room-1', family: 'rooms' },
      },
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(hits).toHaveLength(0);
    expect(ws.sentFrames().find((f) => f.event === 'ask-permission')).toBeUndefined();
    const nak = ws.sentFrames().find((f) => f.event === '__error__');
    expect(nak).toMatchObject({
      payload: { code: 'request-no-response' },
      metadata: { exchange: { id: 'x5' } },
    });
  });

  it('prefers the channel onRequest over a top-level one for a channel-marked frame', async () => {
    const { socket, ws } = build();
    const topHits: unknown[] = [];
    const chanHits: unknown[] = [];
    (socket as any).onRequest('ask-permission', (p: unknown) => {
      topHits.push(p);
      return { allowed: false };
    });
    (socket as any).channel('rooms', 'room-1').onRequest('ask-permission', (p: unknown) => {
      chanHits.push(p);
      return { allowed: true };
    });

    ws.emit({
      event: 'ask-permission',
      payload: { action: 'x' },
      metadata: {
        exchange: { id: 'x7', source: 'server' },
        channel: { name: 'room-1', family: 'rooms' },
      },
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(chanHits).toHaveLength(1);
    expect(topHits).toHaveLength(0);
  });

  it('fast-fails a marked server request with no handler (no-handler decline)', async () => {
    const { socket, ws } = build();
    void socket; // no handler registered

    ws.emit({
      event: 'ask-permission',
      payload: { action: 'x' },
      metadata: { exchange: { id: 'x6', source: 'server' } },
    });
    await new Promise((r) => setTimeout(r, 0));

    const nak = ws.sentFrames().find((f) => f.event === '__error__');
    expect(nak).toMatchObject({
      payload: { code: 'request-no-response' },
      metadata: { exchange: { id: 'x6' } },
    });
  });

  it('passes through an unmarked correlated frame with no handler (a reply)', async () => {
    const { socket, ws } = build();
    // A reply to the client's own request: correlated, NOT marked serverRequests,
    // no serverRequests handler. It must not be NAK'd — clientRequests claims it.
    const pending = (socket as any).request('get-balance', { user: 'a' });
    const reqFrame = ws.sentFrames().find((f) => f.event === 'get-balance');
    const correlationId = reqFrame.metadata.exchange?.id;

    ws.emit({
      event: 'get-balance',
      payload: { balance: 7 },
      metadata: { exchange: { id: correlationId } },
    });
    await expect(pending).resolves.toEqual({ balance: 7 });
    const nak = ws.sentFrames().find((f) => f.event === '__error__');
    expect(nak).toBeUndefined();
  });
});
