import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { keepalive } from '~/primitives/keepalive/index.ts';
import { reconnection } from '~/primitives/reconnection/index.ts';
import { stream } from '~/primitives/stream/index.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamPrimitive } from '~/primitives/stream/types.ts';
import type { ApplyPrimitives } from '~/primitives/types.ts';
import type { Socket } from '~/socket/api.ts';
import type { LiveThingSocket } from '~/socket/socket.ts';
import type { Simplify, StreamHandle } from '~/types.ts';

interface C {
  streams: {
    'ask-ai': {
      payload: { prompt: string };
      chunk: { text: string };
      kind: 'persistent';
      nudges: never;
    };
  };
}

type StreamSocket = Simplify<Socket<C> & ApplyPrimitives<[StreamPrimitive], C>>;

function build() {
  const socket = client<C>()(connect('wss://test'), stream());
  socket.connect();
  const ws = MockWebSocket.last();
  ws.open();

  return { socket, ws };
}

type AskAiHandle = StreamHandle<{ text: string }, Record<never, never>>;

async function start(
  socket: StreamSocket,
  ws: MockWebSocket,
  options?: { streamDurability?: 'ephemeral' | 'persistent' },
): Promise<{ handle: AskAiHandle; sid: string }> {
  const promise = socket.stream('ask-ai', { prompt: 'hi' });
  const sid = ws.sentFrames().at(-1).metadata.stream?.id as string;
  ws.emit({
    event: '__streamOk__',
    payload: {},
    metadata: { stream: { id: sid, durability: options?.streamDurability ?? 'ephemeral' } },
  });
  const handle = await promise;

  return { handle, sid };
}

async function collect<T>(handle: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const chunk of handle) out.push(chunk);
  return out;
}

let restore: () => void;
beforeEach(() => {
  restore = installMockWebSocket();
});
afterEach(() => {
  restore();
});

describe('durable stream survives unexpected drop', () => {
  it('does not throw Disconnected on an unexpected drop and continues after reconnect', async () => {
    vi.useFakeTimers();
    try {
      const socket = client<C>()(connect('wss://test'), stream(), reconnection());
      socket.connect();
      const first = MockWebSocket.last();
      first.open();
      const { handle, sid } = await start(socket, first, { streamDurability: 'persistent' });

      first.emit({
        event: 'ask-ai',
        payload: { text: 'a' },
        metadata: { stream: { id: sid, seq: 1 } },
      });

      // Drop the connection unexpectedly — a persistent stream must NOT throw Disconnected.
      first.serverClose(1006, 'drop');

      vi.advanceTimersByTime(1500);
      const second = MockWebSocket.last();
      second.open();

      second.emit({
        event: 'ask-ai',
        payload: { text: 'b' },
        metadata: { stream: { id: sid, seq: 2 } },
      });
      second.emit({ event: '__streamEnd__', payload: {}, metadata: { stream: { id: sid } } });

      expect(await collect(handle)).toEqual([{ text: 'a' }, { text: 'b' }]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('cancel during reconnect', () => {
  it('holds the cancel until reconnect, then sends it and suppresses continue', async () => {
    vi.useFakeTimers();
    try {
      const socket = client<C>()(connect('wss://test'), stream(), reconnection());
      socket.connect();
      const first = MockWebSocket.last();
      first.open();
      const { handle, sid } = await start(socket, first, { streamDurability: 'persistent' });

      first.serverClose(1006, 'drop');

      // Cancel while reconnecting — the frame can't go out yet, so it's held and the
      // local handle must NOT be torn down (its durable row is still alive server-side).
      handle.cancel();
      expect(handle.active).toBe(true);

      vi.advanceTimersByTime(1500);
      const second = MockWebSocket.last();
      second.open();

      const sent = second.sentFrames();
      expect(
        sent.some((f) => f.event === '__streamCancel__' && f.metadata.stream?.id === sid),
      ).toBe(true);
      expect(
        sent.some((f) => f.event === '__continueStream__' && f.metadata.stream?.id === sid),
      ).toBe(false);

      expect(await collect(handle)).toEqual([]);
      expect((socket as unknown as LiveThingSocket)._lazyConsumers).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles once when cancel() is called several times during reconnect', async () => {
    vi.useFakeTimers();
    try {
      const socket = client<C>()(connect('wss://test'), stream(), reconnection());
      socket.connect();
      const first = MockWebSocket.last();
      first.open();
      const { handle } = await start(socket, first, { streamDurability: 'persistent' });

      first.serverClose(1006, 'drop');
      handle.cancel();
      handle.cancel();
      handle.cancel();

      vi.advanceTimersByTime(1500);
      const second = MockWebSocket.last();
      second.open();

      const cancels = second.sentFrames().filter((f) => f.event === '__streamCancel__');
      expect(cancels).toHaveLength(1);
      expect((socket as unknown as LiveThingSocket)._lazyConsumers).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('durable stream lazy hold across failed reconnects', () => {
  it('releases exactly the hold it owns once, leaving unrelated consumers untouched', async () => {
    vi.useFakeTimers();
    try {
      const socket = client<C>()(connect('wss://test'), stream(), reconnection());
      socket.connect();
      const first = MockWebSocket.last();
      first.open();

      const unrelated = socket.onStream('ask-ai', { onChunk: () => undefined });

      const a = await start(socket, first, { streamDurability: 'persistent' });
      const b = await start(socket, first, { streamDurability: 'persistent' });
      const baseline = (socket as unknown as LiveThingSocket)._lazyConsumers;
      expect(baseline).toBe(3);

      first.serverClose(1006, 'drop');
      vi.advanceTimersByTime(1500);
      MockWebSocket.last().serverClose(1006, 'still down');
      vi.advanceTimersByTime(3000);
      MockWebSocket.last().serverClose(1006, 'still down');

      expect((socket as unknown as LiveThingSocket)._lazyConsumers).toBe(1);

      vi.advanceTimersByTime(6000);
      const reopened = MockWebSocket.last();
      reopened.open();
      expect((socket as unknown as LiveThingSocket)._lazyConsumers).toBe(3);

      reopened.emit({ event: '__streamEnd__', payload: {}, metadata: { stream: { id: a.sid } } });
      reopened.emit({ event: '__streamEnd__', payload: {}, metadata: { stream: { id: b.sid } } });
      expect((socket as unknown as LiveThingSocket)._lazyConsumers).toBe(1);

      unrelated();
      expect((socket as unknown as LiveThingSocket)._lazyConsumers).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('hibernation-wake continue', () => {
  it('re-sends __continueStream__ on stream-aborted/hibernation-wake without ending the stream', async () => {
    const { socket, ws } = build();
    const { handle, sid } = await start(socket, ws, { streamDurability: 'persistent' });

    ws.emit({ event: 'ask-ai', payload: { text: 'a' }, metadata: { stream: { id: sid, seq: 1 } } });

    // Server hibernation-wake error — must NOT end the stream.
    ws.emit({
      event: '__error__',
      payload: { code: 'stream-aborted', detail: { reason: 'hibernation-wake' } },
      metadata: { stream: { id: sid } },
    });

    const frames = ws.sentFrames();
    const continueFrame = frames.find(
      (f) => f.event === '__continueStream__' && f.metadata.stream?.id === sid,
    );
    expect(continueFrame).toBeDefined();

    ws.emit({ event: 'ask-ai', payload: { text: 'b' }, metadata: { stream: { id: sid, seq: 2 } } });
    ws.emit({ event: '__streamEnd__', payload: {}, metadata: { stream: { id: sid } } });

    expect(await collect(handle)).toEqual([{ text: 'a' }, { text: 'b' }]);
  });

  it('hibernation-wake continue frame uses the last delivered seq', async () => {
    const { socket, ws } = build();
    const { sid } = await start(socket, ws, { streamDurability: 'persistent' });

    ws.emit({ event: 'ask-ai', payload: { text: 'a' }, metadata: { stream: { id: sid, seq: 5 } } });

    ws.emit({
      event: '__error__',
      payload: { code: 'stream-aborted', detail: { reason: 'hibernation-wake' } },
      metadata: { stream: { id: sid } },
    });

    const frames = ws.sentFrames();
    const continueFrame = frames.find(
      (f) => f.event === '__continueStream__' && f.metadata.stream?.id === sid,
    );
    expect(continueFrame).toMatchObject({
      event: '__continueStream__',
      payload: { lastKnownSeq: 5 },
      metadata: { stream: { id: sid } },
    });
    socket.disconnect();
  });
});

describe('ephemeral stream not continued on reconnect', () => {
  it('throws Disconnected on unexpected drop and sends no __continueStream__ on reopen', async () => {
    vi.useFakeTimers();
    try {
      const socket = client<C>()(connect('wss://test'), stream(), reconnection());
      socket.connect();
      const first = MockWebSocket.last();
      first.open();

      const { handle, sid } = await start(socket, first, { streamDurability: 'ephemeral' });

      const collectPromise = collect(handle);

      first.serverClose(1006, 'drop');

      await expect(collectPromise).rejects.toMatchObject({ code: 'disconnected' });

      vi.advanceTimersByTime(1500);
      const second = MockWebSocket.last();
      second.open();

      const continueFrames = second
        .sentFrames()
        .filter((f) => f.event === '__continueStream__' && f.metadata?.stream?.id === sid);
      expect(continueFrames).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('__error__ with correlationId passthrough', () => {
  it('leaves the stream running when __error__ carries a correlationId', async () => {
    const { socket, ws } = build();
    const { handle, sid } = await start(socket, ws, { streamDurability: 'persistent' });

    socket.onServerError(() => {});
    ws.emit({
      event: '__error__',
      payload: { code: 'not-found' },
      metadata: { exchange: { id: 'req-abc' }, stream: { id: sid } },
    });

    ws.emit({ event: 'ask-ai', payload: { text: 'a' }, metadata: { stream: { id: sid, seq: 1 } } });
    ws.emit({ event: '__streamEnd__', payload: {}, metadata: { stream: { id: sid } } });

    expect(await collect(handle)).toEqual([{ text: 'a' }]);
  });
});

describe('continueStream reuse branch', () => {
  it('reuses existing state when continueStream is called twice for the same id', async () => {
    const { socket, ws } = build();

    const handleA = socket.continueStream('ask-ai', 'feed-1', { lastKnownSeq: 0 });

    socket.continueStream('ask-ai', 'feed-1', { lastKnownSeq: 0 });

    expect((socket as unknown as LiveThingSocket)._lazyConsumers).toBe(1);

    ws.emit({
      event: 'ask-ai',
      payload: { text: 'x' },
      metadata: { stream: { id: 'feed-1', seq: 1 } },
    });
    ws.emit({ event: '__streamEnd__', payload: {}, metadata: { stream: { id: 'feed-1' } } });

    expect(await collect(handleA)).toEqual([{ text: 'x' }]);
  });

  it('reuses state for a stream already created by __streamOk__', async () => {
    const { socket, ws } = build();
    const { handle, sid } = await start(socket, ws, { streamDurability: 'persistent' });

    const consumersAfterStart = (socket as unknown as LiveThingSocket)._lazyConsumers;

    socket.continueStream('ask-ai', sid, { lastKnownSeq: 0 });

    // lazyAcquire must NOT have been called again; the consumer count stays the same.
    expect((socket as unknown as LiveThingSocket)._lazyConsumers).toBe(consumersAfterStart);

    ws.emit({ event: 'ask-ai', payload: { text: 'z' }, metadata: { stream: { id: sid, seq: 1 } } });
    ws.emit({ event: '__streamEnd__', payload: {}, metadata: { stream: { id: sid } } });

    expect(await collect(handle)).toEqual([{ text: 'z' }]);
  });
});

describe('continueStream default lastKnownSeq from state', () => {
  it('sends payload {} when no chunk has been delivered and no lastKnownSeq is given', () => {
    const { socket, ws } = build();

    socket.continueStream('ask-ai', 'feed-fresh');

    const frame = ws.sentFrames().at(-1);
    expect(frame).toEqual({
      event: '__continueStream__',
      payload: {},
      metadata: { stream: { id: 'feed-fresh' } },
    });
    socket.disconnect();
  });

  it('uses the state-derived seq when reconnect-continue omits an explicit lastKnownSeq', async () => {
    vi.useFakeTimers();
    try {
      const socket = client<C>()(connect('wss://test'), stream(), reconnection());
      socket.connect();
      const first = MockWebSocket.last();
      first.open();

      const { sid } = await start(socket, first, { streamDurability: 'persistent' });
      first.emit({
        event: 'ask-ai',
        payload: { text: 'a' },
        metadata: { stream: { id: sid, seq: 3 } },
      });

      first.serverClose(1006, 'drop');
      vi.advanceTimersByTime(1500);
      const second = MockWebSocket.last();
      second.open();

      expect(second.sentFrames()).toContainEqual({
        event: '__continueStream__',
        payload: { lastKnownSeq: 3 },
        metadata: { stream: { id: sid } },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('durable stream releases lazy hold when socket closes with no reconnect', () => {
  it('drops _lazyConsumers to 0 after a persistent stream on a lazy socket closes permanently (code 1006, no reconnect)', async () => {
    const socket = client<C>()(connect('wss://test', { lazy: true }), stream());
    socket.connect();
    const ws = MockWebSocket.last();
    ws.open();

    await start(socket, ws, { streamDurability: 'persistent' });

    expect((socket as unknown as LiveThingSocket)._lazyConsumers).toBe(1);

    ws.serverClose(1006, 'drop');

    expect((socket as unknown as LiveThingSocket)._lazyConsumers).toBe(0);
  });
});

describe('per-chunk timeout must not start at reconnect for a continued stream', () => {
  it('does not abort a durable stream with Timeout while waiting for the first continued chunk after reconnect', async () => {
    vi.useFakeTimers();
    try {
      const socket = client<C>()(connect('wss://test'), stream({ timeout: 1000 }), reconnection());
      socket.connect();
      const first = MockWebSocket.last();
      first.open();

      const { handle, sid } = await start(socket, first, { streamDurability: 'persistent' });

      first.emit({
        event: 'ask-ai',
        payload: { text: 'a' },
        metadata: { stream: { id: sid, seq: 1 } },
      });
      first.serverClose(1006, 'drop');

      vi.advanceTimersByTime(500);
      const second = MockWebSocket.last();
      second.open();

      // The reconnect sends a __continueStream__ frame. We have NOT yet received
      // the first continued chunk. Advance past the full per-chunk timeout — the
      // stream is still waiting for its first continued chunk and must NOT be aborted.
      // If the timer started at reconnect (the bug), advancing past 1000ms fires
      // Timeout before the first chunk arrives. Correct behavior: the timer should
      // only start when the first continued chunk is received.
      vi.advanceTimersByTime(1100);

      second.emit({
        event: 'ask-ai',
        payload: { text: 'b' },
        metadata: { stream: { id: sid, seq: 2 } },
      });
      second.emit({ event: '__streamEnd__', payload: {}, metadata: { stream: { id: sid } } });

      // Both chunks must arrive — the stream must NOT have been aborted by a
      // premature Timeout while waiting for the first continued chunk.
      await expect(collect(handle)).resolves.toEqual([{ text: 'a' }, { text: 'b' }]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('durable stream finishes when reconnection permanently gives up', () => {
  it('ends a kept persistent stream with Disconnected when retries are exhausted', async () => {
    vi.useFakeTimers();
    try {
      const socket = client<C>()(
        connect('wss://test'),
        stream({ timeout: 0 }),
        reconnection({ maxAttempts: 1 }),
      );
      socket.connect();
      const first = MockWebSocket.last();
      first.open();
      const { handle } = await start(socket, first, { streamDurability: 'persistent' });

      const drained = collect(handle).then(
        () => null,
        (error) => error,
      );
      await Promise.resolve();

      // Drop, fire the one retry, then drop the retry BEFORE it opens so the
      // attempt counter is never reset — reconnection exhausts maxAttempts and
      // calls failReconnect(), which must finish the kept stream.
      first.serverClose(1006, 'drop');
      await vi.advanceTimersByTimeAsync(1500);
      const second = MockWebSocket.last();
      second.serverClose(1006, 'retry failed');

      expect(socket.state.get()).toBe('closed');
      expect(await drained).toMatchObject({ code: 'disconnected' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('ends a kept persistent stream with Disconnected on a non-retryable close', async () => {
    const socket = client<C>()(
      connect('wss://test'),
      stream({ timeout: 0 }),
      reconnection({ nonRetryableCodes: [4001] }),
    );
    socket.connect();
    const ws = MockWebSocket.last();
    ws.open();
    const { handle } = await start(socket, ws, { streamDurability: 'persistent' });

    const drained = collect(handle).then(
      () => null,
      (error) => error,
    );
    await Promise.resolve();

    ws.serverClose(4001, 'policy');

    expect(socket.state.get()).toBe('closed');
    expect(await drained).toMatchObject({ code: 'disconnected' });
  });
});

describe('stream teardown, pre-open triggers, and continue deadline', () => {
  it('a durable stream ends with Disconnected on an unexpected drop when no reconnection is installed', async () => {
    const { socket, ws } = build();
    const { handle } = await start(socket, ws, { streamDurability: 'persistent' });

    const drained = collect(handle);
    await Promise.resolve();
    ws.serverClose(1006, 'drop');

    await expect(drained).rejects.toMatchObject({ code: 'disconnected' });
  });

  it('flushes a stream() trigger that was sent before the socket opened', async () => {
    const socket = client<C>()(connect('wss://test', { lazy: true }), stream({ timeout: 0 }));
    const promise = socket.stream('ask-ai', { prompt: 'hi' });

    const ws = MockWebSocket.last();
    expect(ws.sentFrames()).toEqual([]);

    ws.open();
    const sent = ws.sentFrames().find((f) => f.event === 'ask-ai');
    expect(sent).toBeDefined();

    const sid = sent.metadata.stream?.id as string;
    ws.emit({
      event: '__streamOk__',
      payload: {},
      metadata: { stream: { id: sid, durability: 'ephemeral' } },
    });
    await expect(promise).resolves.toBeDefined();
  });

  it('aborts a continued stream with Timeout if the server never sends a continued chunk', async () => {
    vi.useFakeTimers();
    try {
      const socket = client<C>()(connect('wss://test'), stream({ timeout: 1000 }), reconnection());
      socket.connect();
      const first = MockWebSocket.last();
      first.open();
      const { handle } = await start(socket, first, { streamDurability: 'persistent' });

      first.serverClose(1006, 'drop');
      vi.advanceTimersByTime(500);
      const second = MockWebSocket.last();
      second.open();

      // Capture the rejection up front so it can't surface as an unhandled one.
      const drained = collect(handle).then(
        () => null,
        (error) => error,
      );
      await vi.advanceTimersByTimeAsync(31_000);
      expect(await drained).toMatchObject({ code: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a continued stream alive after a reconnect __streamOk__ even when the first chunk is slow', async () => {
    vi.useFakeTimers();
    try {
      const socket = client<C>()(connect('wss://test'), stream({ timeout: 1000 }), reconnection());
      socket.connect();
      const first = MockWebSocket.last();
      first.open();
      const { handle, sid } = await start(socket, first, { streamDurability: 'persistent' });

      first.serverClose(1006, 'drop');
      vi.advanceTimersByTime(500);
      const second = MockWebSocket.last();
      second.open();

      second.emit({
        event: '__streamOk__',
        payload: {},
        metadata: { stream: { id: sid, durability: 'persistent' } },
      });

      // Advance well past the 30s continue deadline with no chunk: the acked stream
      // must NOT be aborted by the now-stale deadline.
      await vi.advanceTimersByTimeAsync(31_000);

      second.emit({
        event: 'ask-ai',
        payload: { text: 'late' },
        metadata: { stream: { id: sid, seq: 1 } },
      });
      second.emit({ event: '__streamEnd__', payload: {}, metadata: { stream: { id: sid } } });

      await expect(collect(handle)).resolves.toEqual([{ text: 'late' }]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('durable stream without keepalive warns in debug mode', () => {
  function warnedAboutKeepalive(warn: ReturnType<typeof vi.spyOn>): boolean {
    return warn.mock.calls.some((args: unknown[]) =>
      args.some((a: unknown) => String(a).includes('keepalive')),
    );
  }

  it('warns once when a persistent stream is confirmed and keepalive is absent', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const socket = client<C>()(connect('wss://test'), stream());
      socket.setDebug(true);
      socket.connect();
      const ws = MockWebSocket.last();
      ws.open();

      await start(socket, ws, { streamDurability: 'persistent' });
      expect(warnedAboutKeepalive(warn)).toBe(true);
      socket.disconnect();
    } finally {
      warn.mockRestore();
    }
  });

  it('does not warn when keepalive is installed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const socket = client<C>()(connect('wss://test'), stream(), keepalive({ interval: 0 }));
      socket.setDebug(true);
      socket.connect();
      const ws = MockWebSocket.last();
      ws.open();

      await start(socket, ws, { streamDurability: 'persistent' });
      expect(warnedAboutKeepalive(warn)).toBe(false);
      socket.disconnect();
    } finally {
      warn.mockRestore();
    }
  });

  it('does not warn for an ephemeral (non-durable) stream', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const socket = client<C>()(connect('wss://test'), stream());
      socket.setDebug(true);
      socket.connect();
      const ws = MockWebSocket.last();
      ws.open();

      await start(socket, ws, { streamDurability: 'ephemeral' });
      expect(warnedAboutKeepalive(warn)).toBe(false);
      socket.disconnect();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('connection setup retry exhaustion', () => {
  it('rejects a queued stream when URL setup fails and reconnection gives up', async () => {
    const socket = client<C>()(
      connect(
        async () => {
          throw new Error('URL setup failed');
        },
        { lazy: true },
      ),
      stream({ timeout: 0 }),
      reconnection({ maxAttempts: 0 }),
    );
    socket.onError(() => undefined);

    const pending = socket.stream('ask-ai', { prompt: 'hi' });

    await expect(pending).rejects.toMatchObject({ code: 'disconnected' });
  });
});
