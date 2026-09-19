import { WIRE_LIMITS } from '@livething/core';
import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { buffering } from '~/primitives/buffering/index.ts';
import { clientRequests } from '~/primitives/client-requests/index.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Primitive } from '~/primitives/types.ts';

interface C {
  clientRequests: {
    'get-balance': { payload: { user: string }; response: { balance: number } };
  };
}

function build(options?: Parameters<typeof clientRequests>[0]) {
  const socket = client<C>()(connect('wss://test'), clientRequests(options));
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

describe('clientRequests — buffered frame ownership', () => {
  it('does not send a timed-out request after reconnect', async () => {
    vi.useFakeTimers();
    const socket = client<C>()(
      connect('wss://test'),
      buffering({ enabled: true }),
      clientRequests({ timeout: 5000 }),
    );
    socket.connect();
    let ws = MockWebSocket.last();
    ws.open();

    ws.serverClose(1006);

    const settled = vi.fn();
    socket.request('get-balance', { user: 'a' }).then(
      () => settled('resolved'),
      (e: { code?: string }) => settled(e?.code),
    );

    vi.advanceTimersByTime(5000);
    await Promise.resolve();
    expect(settled).toHaveBeenCalledWith('timeout');

    // Reconnect: the timed-out frame must NOT be put on the wire.
    socket.connect();
    ws = MockWebSocket.last();
    ws.open();
    expect(ws.sentFrames().some((f) => f.event === 'get-balance')).toBe(false);
    vi.useRealTimers();
  });

  it('rejects the exact request whose held frame cannot serialize on flush, later requests still flush', async () => {
    const socket = client<C>()(connect('wss://test', { lazy: true }), clientRequests());
    socket.onError(() => undefined);
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const bad = socket.request('get-balance', circular as unknown as { user: string });
    const good = socket.request('get-balance', { user: 'b' });
    void bad.catch(() => undefined);

    const ws = MockWebSocket.last();
    ws.open();

    await expect(bad).rejects.toBeInstanceOf(TypeError);
    const cid = ws.sentFrames().at(-1).metadata.exchange?.id;
    ws.emit({ event: 'get-balance', payload: { balance: 9 }, metadata: { exchange: { id: cid } } });
    await expect(good).resolves.toEqual({ balance: 9 });
  });
});

describe('clientRequests', () => {
  it('rejects and cleans up timer/pending when the payload will not serialize (#15)', async () => {
    vi.useFakeTimers();
    const { socket, ws } = build();
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await expect(
      socket.request('get-balance', circular as { user: string }),
    ).rejects.toBeInstanceOf(TypeError);

    vi.advanceTimersByTime(60_000);
    const promise = socket.request('get-balance', { user: 'b' });
    const cid = ws.sentFrames().at(-1).metadata.exchange?.id;
    ws.emit({ event: 'get-balance', payload: { balance: 5 }, metadata: { exchange: { id: cid } } });
    await expect(promise).resolves.toEqual({ balance: 5 });

    vi.useRealTimers();
  });

  it('rejects a reserved event name locally with validation-failed and no send', async () => {
    const { socket, ws } = build();
    const request = socket.request as (e: string, p: unknown) => Promise<unknown>;
    for (const name of ['ping', 'pong', '__error__']) {
      await expect(request(name, { user: 'a' })).rejects.toMatchObject({
        code: 'validation-failed',
      });
    }

    expect(ws.sentFrames()).toHaveLength(0);
  });

  it('rejects an over-limit event name locally with validation-failed, no send (#3)', async () => {
    const { socket, ws } = build();
    const longEvent = 'e'.repeat(WIRE_LIMITS.event + 1);
    await expect(
      (socket.request as (e: string, p: unknown) => Promise<unknown>)(longEvent, { user: 'a' }),
    ).rejects.toMatchObject({ code: 'validation-failed' });
    expect(ws.sentFrames()).toHaveLength(0);
  });

  it('resolves with the matching response', async () => {
    const { socket, ws } = build();
    const promise = socket.request('get-balance', { user: 'a' });
    const cid = ws.sentFrames().at(-1).metadata.exchange?.id;
    expect(typeof cid).toBe('string');
    ws.emit({
      event: 'get-balance',
      payload: { balance: 10 },
      metadata: { exchange: { id: cid } },
    });

    await expect(promise).resolves.toEqual({ balance: 10 });
  });

  it('turns a null wire payload into an undefined void response', async () => {
    const { socket, ws } = build();
    const promise = socket.request('get-balance', { user: 'a' });
    const cid = ws.sentFrames().at(-1).metadata.exchange?.id;

    ws.emit({
      event: 'get-balance',
      payload: null,
      metadata: { exchange: { id: cid } },
    });

    await expect(promise).resolves.toBeUndefined();
  });

  it('resolves two concurrent requests independently, matched by correlationId out of order', async () => {
    const { socket, ws } = build();
    const p1 = socket.request('get-balance', { user: 'a' });
    const p2 = socket.request('get-balance', { user: 'b' });

    const frames = ws.sentFrames();
    const cid1 = frames.at(-2).metadata.exchange?.id;
    const cid2 = frames.at(-1).metadata.exchange?.id;
    expect(cid1).not.toBe(cid2);

    // Reply to the SECOND request first — arrival order must not matter; each
    // promise settles by its own correlationId.
    ws.emit({
      event: 'get-balance',
      payload: { balance: 2 },
      metadata: { exchange: { id: cid2 } },
    });
    ws.emit({
      event: 'get-balance',
      payload: { balance: 1 },
      metadata: { exchange: { id: cid1 } },
    });

    await expect(p1).resolves.toEqual({ balance: 1 });
    await expect(p2).resolves.toEqual({ balance: 2 });
  });

  it('rejects with a typed error frame', async () => {
    const { socket, ws } = build();
    const promise = socket.request('get-balance', { user: 'a' });
    const cid = ws.sentFrames().at(-1).metadata.exchange?.id;
    ws.emit({
      event: '__error__',
      payload: { code: 'forbidden', detail: { reason: 'no' } },
      metadata: { exchange: { id: cid } },
    });
    await expect(promise).rejects.toMatchObject({ code: 'forbidden', detail: { reason: 'no' } });
  });

  it('rejects with Disconnected when disconnected while waiting', async () => {
    const { socket } = build();
    const promise = socket.request('get-balance', { user: 'a' });
    socket.disconnect();
    await expect(promise).rejects.toMatchObject({ code: 'disconnected' });
  });

  it('sends a request made before open once the socket opens, instead of dropping it', async () => {
    const socket = client<C>()(connect('wss://test'), clientRequests());
    socket.connect();
    const ws = MockWebSocket.last();

    const promise = socket.request('get-balance', { user: 'a' });
    expect(ws.sentFrames()).toHaveLength(0);

    ws.open();
    const cid = ws.sentFrames().at(-1).metadata.exchange?.id;
    expect(typeof cid).toBe('string');

    ws.emit({ event: 'get-balance', payload: { balance: 7 }, metadata: { exchange: { id: cid } } });
    await expect(promise).resolves.toEqual({ balance: 7 });
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

  it('drops a late reply to an already-settled request so it does not leak to onError', () => {
    vi.useFakeTimers();
    try {
      const { socket, ws } = build({ timeout: 1000 });
      const onError = vi.fn();
      socket.onError(onError);
      socket.request('get-balance', { user: 'u1' }).catch(() => undefined);

      const sent = ws.sentFrames().find((f) => f.event === 'get-balance');
      const correlationId = sent?.metadata?.exchange?.id as string;
      expect(typeof correlationId).toBe('string');

      vi.advanceTimersByTime(1000);

      ws.emit({
        event: '__error__',
        payload: { code: 'forbidden' },
        metadata: { exchange: { id: correlationId } },
      });
      expect(onError).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('clientRequests — unmatched-correlationId passthrough', () => {
  function buildWithSpy() {
    const seen: string[] = [];
    const spy = {
      _tag: 'incoming-spy',
      dependencies: ['clientRequests'],
      setup() {
        return {
          id: 'incoming-spy',
          onIncoming(message: { event: string }) {
            seen.push(message.event);
            return message;
          },
        };
      },
    };

    const socket = client<C>()(
      connect('wss://test'),
      clientRequests(),
      spy as unknown as Primitive,
    );
    socket.connect();
    const ws = MockWebSocket.last();

    ws.open();

    return { socket, ws, seen };
  }

  it('forwards a protocol frame with an unknown correlationId so another primitive can claim it', () => {
    const { ws, seen } = buildWithSpy();

    ws.emit({
      event: '__readQuery__',
      payload: { identities: ['alice'] },
      metadata: { exchange: { id: 'never-sent' } },
    });

    expect(seen).toEqual(['__readQuery__']);
  });

  it('drops a stale __error__ with an unknown correlationId instead of forwarding it', () => {
    const { ws, seen } = buildWithSpy();

    ws.emit({
      event: '__error__',
      payload: { code: 'forbidden' },
      metadata: { exchange: { id: 'stale' } },
    });

    expect(seen).toEqual([]);
  });

  it('drops a user-event reply with an unknown correlationId', () => {
    const { ws, seen } = buildWithSpy();

    ws.emit({
      event: 'get-balance',
      payload: { balance: 1 },
      metadata: { exchange: { id: 'orphan' } },
    });

    expect(seen).toEqual([]);
  });

  it('forwards a server-source frame untouched for the serverRequests primitive', () => {
    const { ws, seen } = buildWithSpy();

    ws.emit({
      event: 'server-ask',
      payload: {},
      metadata: { exchange: { id: 'srv-1', source: 'server' } },
    });

    expect(seen).toEqual(['server-ask']);
  });
});
