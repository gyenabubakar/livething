import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { requestResponse } from '~/primitives/request-response/index.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface C {
  requests: {
    'get-balance': { payload: { user: string }; response: { balance: number } };
  };
}

function build(options?: Parameters<typeof requestResponse>[0]) {
  const socket = client<C>()(connect('wss://test'), requestResponse(options));
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

describe('requestResponse', () => {
  it('resolves with the matching response', async () => {
    const { socket, ws } = build();
    const promise = socket.request('get-balance', { user: 'a' });
    const cid = ws.sentFrames().at(-1).__wskit.correlationId;
    expect(typeof cid).toBe('string');
    ws.emit({ event: 'get-balance', payload: { balance: 10 }, __wskit: { correlationId: cid } });
    await expect(promise).resolves.toEqual({ balance: 10 });
  });

  it('resolves two concurrent requests independently, matched by correlationId out of order', async () => {
    const { socket, ws } = build();
    const p1 = socket.request('get-balance', { user: 'a' });
    const p2 = socket.request('get-balance', { user: 'b' });

    const frames = ws.sentFrames();
    const cid1 = frames.at(-2).__wskit.correlationId;
    const cid2 = frames.at(-1).__wskit.correlationId;
    expect(cid1).not.toBe(cid2);

    // Reply to the SECOND request first — arrival order must not matter; each
    // promise settles by its own correlationId.
    ws.emit({ event: 'get-balance', payload: { balance: 2 }, __wskit: { correlationId: cid2 } });
    ws.emit({ event: 'get-balance', payload: { balance: 1 }, __wskit: { correlationId: cid1 } });

    await expect(p1).resolves.toEqual({ balance: 1 });
    await expect(p2).resolves.toEqual({ balance: 2 });
  });

  it('rejects with a typed error frame', async () => {
    const { socket, ws } = build();
    const promise = socket.request('get-balance', { user: 'a' });
    const cid = ws.sentFrames().at(-1).__wskit.correlationId;
    ws.emit({
      event: '__error__',
      payload: { code: 'forbidden', detail: { reason: 'no' } },
      __wskit: { correlationId: cid },
    });
    await expect(promise).rejects.toMatchObject({ code: 'forbidden', detail: { reason: 'no' } });
  });

  it('rejects with Disconnected when disconnected while waiting', async () => {
    const { socket } = build();
    const promise = socket.request('get-balance', { user: 'a' });
    socket.disconnect();
    await expect(promise).rejects.toMatchObject({ code: 'disconnected' });
  });

  it('rejects with Timeout when no reply arrives', async () => {
    vi.useFakeTimers();
    try {
      const { socket } = build({ timeout: 1000 });
      const promise = socket.request('get-balance', { user: 'a' });
      const assertion = expect(promise).rejects.toMatchObject({ code: 'timeout' });
      vi.advanceTimersByTime(1000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
