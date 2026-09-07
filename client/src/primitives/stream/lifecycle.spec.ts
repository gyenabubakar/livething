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
import type { WSKitSocket } from '~/socket/socket.ts';
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
  options?: { streamKind?: 'ephemeral' | 'persistent' },
): Promise<{ handle: AskAiHandle; sid: string }> {
  const promise = socket.stream('ask-ai', { prompt: 'hi' });
  const sid = ws.sentFrames().at(-1).__wskit.streamId as string;
  ws.emit({
    event: '__streamOk__',
    payload: {},
    __wskit: { streamId: sid, streamKind: options?.streamKind ?? 'ephemeral' },
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
  it('does not throw Disconnected on an unexpected drop and resumes after reconnect', async () => {
    vi.useFakeTimers();
    try {
      const socket = client<C>()(connect('wss://test'), stream(), reconnection());
      socket.connect();
      const first = MockWebSocket.last();
      first.open();
      const { handle, sid } = await start(socket, first, { streamKind: 'persistent' });

      first.emit({ event: 'ask-ai', payload: { text: 'a' }, __wskit: { streamId: sid, seq: 1 } });

      // Drop the connection unexpectedly — a persistent stream must NOT throw Disconnected.
      first.serverClose(1006, 'drop');

      vi.advanceTimersByTime(1500);
      const second = MockWebSocket.last();
      second.open();

      second.emit({ event: 'ask-ai', payload: { text: 'b' }, __wskit: { streamId: sid, seq: 2 } });
      second.emit({ event: '__streamEnd__', payload: {}, __wskit: { streamId: sid } });

      expect(await collect(handle)).toEqual([{ text: 'a' }, { text: 'b' }]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('cancel during reconnect', () => {
  it('holds the cancel until reconnect, then sends it and suppresses resume', async () => {
    vi.useFakeTimers();
    try {
      const socket = client<C>()(connect('wss://test'), stream(), reconnection());
      socket.connect();
      const first = MockWebSocket.last();
      first.open();
      const { handle, sid } = await start(socket, first, { streamKind: 'persistent' });

      first.serverClose(1006, 'drop');

      // Cancel while reconnecting — the frame can't go out yet, so it's held and the
      // local handle must NOT be torn down (its durable row is still alive server-side).
      handle.cancel();
      expect(handle.active).toBe(true);

      vi.advanceTimersByTime(1500);
      const second = MockWebSocket.last();
      second.open();

      const sent = second.sentFrames();
      expect(sent.some((f) => f.event === '__streamCancel__' && f.__wskit.streamId === sid)).toBe(
        true,
      );
      expect(sent.some((f) => f.event === '__resumeStream__' && f.__wskit.streamId === sid)).toBe(
        false,
      );

      expect(await collect(handle)).toEqual([]);
      expect((socket as unknown as WSKitSocket)._lazyConsumers).toBe(0);
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
      const { handle } = await start(socket, first, { streamKind: 'persistent' });

      first.serverClose(1006, 'drop');
      handle.cancel();
      handle.cancel();
      handle.cancel();

      vi.advanceTimersByTime(1500);
      const second = MockWebSocket.last();
      second.open();

      const cancels = second.sentFrames().filter((f) => f.event === '__streamCancel__');
      expect(cancels).toHaveLength(1);
      expect((socket as unknown as WSKitSocket)._lazyConsumers).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('resumable stream lazy hold across failed reconnects', () => {
  it('releases exactly the hold it owns once, leaving unrelated consumers untouched', async () => {
    vi.useFakeTimers();
    try {
      const socket = client<C>()(connect('wss://test'), stream(), reconnection());
      socket.connect();
      const first = MockWebSocket.last();
      first.open();

      const unrelated = socket.onStream('ask-ai', { onChunk: () => undefined });

      const a = await start(socket, first, { streamKind: 'persistent' });
      const b = await start(socket, first, { streamKind: 'persistent' });
      const baseline = (socket as unknown as WSKitSocket)._lazyConsumers;
      expect(baseline).toBe(3);

      first.serverClose(1006, 'drop');
      vi.advanceTimersByTime(1500);
      MockWebSocket.last().serverClose(1006, 'still down');
      vi.advanceTimersByTime(3000);
      MockWebSocket.last().serverClose(1006, 'still down');

      expect((socket as unknown as WSKitSocket)._lazyConsumers).toBe(1);

      vi.advanceTimersByTime(6000);
      const reopened = MockWebSocket.last();
      reopened.open();
      expect((socket as unknown as WSKitSocket)._lazyConsumers).toBe(3);

      reopened.emit({ event: '__streamEnd__', payload: {}, __wskit: { streamId: a.sid } });
      reopened.emit({ event: '__streamEnd__', payload: {}, __wskit: { streamId: b.sid } });
      expect((socket as unknown as WSKitSocket)._lazyConsumers).toBe(1);

      unrelated();
      expect((socket as unknown as WSKitSocket)._lazyConsumers).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('hibernation-wake resume', () => {
  it('re-sends __resumeStream__ on stream-aborted/hibernation-wake without ending the stream', async () => {
    const { socket, ws } = build();
    const { handle, sid } = await start(socket, ws, { streamKind: 'persistent' });

    ws.emit({ event: 'ask-ai', payload: { text: 'a' }, __wskit: { streamId: sid, seq: 1 } });

    // Server hibernation-wake error — must NOT end the stream.
    ws.emit({
      event: '__error__',
      payload: { code: 'stream-aborted', detail: { reason: 'hibernation-wake' } },
      __wskit: { streamId: sid },
    });

    const frames = ws.sentFrames();
    const resumeFrame = frames.find(
      (f) => f.event === '__resumeStream__' && f.__wskit.streamId === sid,
    );
    expect(resumeFrame).toBeDefined();

    ws.emit({ event: 'ask-ai', payload: { text: 'b' }, __wskit: { streamId: sid, seq: 2 } });
    ws.emit({ event: '__streamEnd__', payload: {}, __wskit: { streamId: sid } });

    expect(await collect(handle)).toEqual([{ text: 'a' }, { text: 'b' }]);
  });

  it('hibernation-wake resume frame uses the last delivered seq', async () => {
    const { socket, ws } = build();
    const { sid } = await start(socket, ws, { streamKind: 'persistent' });

    ws.emit({ event: 'ask-ai', payload: { text: 'a' }, __wskit: { streamId: sid, seq: 5 } });

    ws.emit({
      event: '__error__',
      payload: { code: 'stream-aborted', detail: { reason: 'hibernation-wake' } },
      __wskit: { streamId: sid },
    });

    const frames = ws.sentFrames();
    const resumeFrame = frames.find(
      (f) => f.event === '__resumeStream__' && f.__wskit.streamId === sid,
    );
    expect(resumeFrame).toMatchObject({
      event: '__resumeStream__',
      payload: { lastKnownSeq: 5 },
      __wskit: { streamId: sid },
    });
    socket.disconnect();
  });
});

describe('ephemeral stream not resumed on reconnect', () => {
  it('throws Disconnected on unexpected drop and sends no __resumeStream__ on reopen', async () => {
    vi.useFakeTimers();
    try {
      const socket = client<C>()(connect('wss://test'), stream(), reconnection());
      socket.connect();
      const first = MockWebSocket.last();
      first.open();

      const { handle, sid } = await start(socket, first, { streamKind: 'ephemeral' });

      const collectPromise = collect(handle);

      first.serverClose(1006, 'drop');

      await expect(collectPromise).rejects.toMatchObject({ code: 'disconnected' });

      vi.advanceTimersByTime(1500);
      const second = MockWebSocket.last();
      second.open();

      const resumeFrames = second
        .sentFrames()
        .filter((f) => f.event === '__resumeStream__' && f.__wskit?.streamId === sid);
      expect(resumeFrames).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('__error__ with correlationId passthrough', () => {
  it('leaves the stream running when __error__ carries a correlationId', async () => {
    const { socket, ws } = build();
    const { handle, sid } = await start(socket, ws, { streamKind: 'persistent' });

    socket.onServerError(() => {});
    ws.emit({
      event: '__error__',
      payload: { code: 'not-found' },
      __wskit: { streamId: sid, correlationId: 'req-abc' },
    });

    ws.emit({ event: 'ask-ai', payload: { text: 'a' }, __wskit: { streamId: sid, seq: 1 } });
    ws.emit({ event: '__streamEnd__', payload: {}, __wskit: { streamId: sid } });

    expect(await collect(handle)).toEqual([{ text: 'a' }]);
  });
});

describe('resumeStream reuse branch', () => {
  it('reuses existing state when resumeStream is called twice for the same id', async () => {
    const { socket, ws } = build();

    const handleA = socket.resumeStream('ask-ai', 'feed-1', { lastKnownSeq: 0 });

    socket.resumeStream('ask-ai', 'feed-1', { lastKnownSeq: 0 });

    expect((socket as unknown as WSKitSocket)._lazyConsumers).toBe(1);

    ws.emit({ event: 'ask-ai', payload: { text: 'x' }, __wskit: { streamId: 'feed-1', seq: 1 } });
    ws.emit({ event: '__streamEnd__', payload: {}, __wskit: { streamId: 'feed-1' } });

    expect(await collect(handleA)).toEqual([{ text: 'x' }]);
  });

  it('reuses state for a stream already created by __streamOk__', async () => {
    const { socket, ws } = build();
    const { handle, sid } = await start(socket, ws, { streamKind: 'persistent' });

    const consumersAfterStart = (socket as unknown as WSKitSocket)._lazyConsumers;

    socket.resumeStream('ask-ai', sid, { lastKnownSeq: 0 });

    // lazyAcquire must NOT have been called again; the consumer count stays the same.
    expect((socket as unknown as WSKitSocket)._lazyConsumers).toBe(consumersAfterStart);

    ws.emit({ event: 'ask-ai', payload: { text: 'z' }, __wskit: { streamId: sid, seq: 1 } });
    ws.emit({ event: '__streamEnd__', payload: {}, __wskit: { streamId: sid } });

    expect(await collect(handle)).toEqual([{ text: 'z' }]);
  });
});

describe('resumeStream default lastKnownSeq from state', () => {
  it('sends payload {} when no chunk has been delivered and no lastKnownSeq is given', () => {
    const { socket, ws } = build();

    socket.resumeStream('ask-ai', 'feed-fresh');

    const frame = ws.sentFrames().at(-1);
    expect(frame).toEqual({
      event: '__resumeStream__',
      payload: {},
      __wskit: { streamId: 'feed-fresh' },
    });
    socket.disconnect();
  });

  it('uses the state-derived seq when reconnect-resume omits an explicit lastKnownSeq', async () => {
    vi.useFakeTimers();
    try {
      const socket = client<C>()(connect('wss://test'), stream(), reconnection());
      socket.connect();
      const first = MockWebSocket.last();
      first.open();

      const { sid } = await start(socket, first, { streamKind: 'persistent' });
      first.emit({ event: 'ask-ai', payload: { text: 'a' }, __wskit: { streamId: sid, seq: 3 } });

      first.serverClose(1006, 'drop');
      vi.advanceTimersByTime(1500);
      const second = MockWebSocket.last();
      second.open();

      expect(second.sentFrames()).toContainEqual({
        event: '__resumeStream__',
        payload: { lastKnownSeq: 3 },
        __wskit: { streamId: sid },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('resumable stream releases lazy hold when socket closes with no reconnect', () => {
  it('drops _lazyConsumers to 0 after a persistent stream on a lazy socket closes permanently (code 1006, no reconnect)', async () => {
    const socket = client<C>()(connect('wss://test', { lazy: true }), stream());
    socket.connect();
    const ws = MockWebSocket.last();
    ws.open();

    await start(socket, ws, { streamKind: 'persistent' });

    expect((socket as unknown as WSKitSocket)._lazyConsumers).toBe(1);

    ws.serverClose(1006, 'drop');

    expect((socket as unknown as WSKitSocket)._lazyConsumers).toBe(0);
  });
});

describe('per-chunk timeout must not start at reconnect for a resumed stream', () => {
  it('does not abort a resumable stream with Timeout while waiting for the first resumed chunk after reconnect', async () => {
    vi.useFakeTimers();
    try {
      const socket = client<C>()(connect('wss://test'), stream({ timeout: 1000 }), reconnection());
      socket.connect();
      const first = MockWebSocket.last();
      first.open();

      const { handle, sid } = await start(socket, first, { streamKind: 'persistent' });

      first.emit({ event: 'ask-ai', payload: { text: 'a' }, __wskit: { streamId: sid, seq: 1 } });
      first.serverClose(1006, 'drop');

      vi.advanceTimersByTime(500);
      const second = MockWebSocket.last();
      second.open();

      // The reconnect sends a __resumeStream__ frame. We have NOT yet received
      // the first resumed chunk. Advance past the full per-chunk timeout — the
      // stream is still waiting for its first resumed chunk and must NOT be aborted.
      // If the timer started at reconnect (the bug), advancing past 1000ms fires
      // Timeout before the first chunk arrives. Correct behavior: the timer should
      // only start when the first resumed chunk is received.
      vi.advanceTimersByTime(1100);

      second.emit({ event: 'ask-ai', payload: { text: 'b' }, __wskit: { streamId: sid, seq: 2 } });
      second.emit({ event: '__streamEnd__', payload: {}, __wskit: { streamId: sid } });

      // Both chunks must arrive — the stream must NOT have been aborted by a
      // premature Timeout while waiting for the first resumed chunk.
      await expect(collect(handle)).resolves.toEqual([{ text: 'a' }, { text: 'b' }]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('resumable stream finishes when reconnection permanently gives up', () => {
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
      const { handle } = await start(socket, first, { streamKind: 'persistent' });

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
    const { handle } = await start(socket, ws, { streamKind: 'persistent' });

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

describe('stream teardown, pre-open triggers, and resume deadline', () => {
  it('a resumable stream ends with Disconnected on an unexpected drop when no reconnection is installed', async () => {
    const { socket, ws } = build();
    const { handle } = await start(socket, ws, { streamKind: 'persistent' });

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

    const sid = sent.__wskit.streamId as string;
    ws.emit({
      event: '__streamOk__',
      payload: {},
      __wskit: { streamId: sid, streamKind: 'ephemeral' },
    });
    await expect(promise).resolves.toBeDefined();
  });

  it('aborts a resumed stream with Timeout if the server never sends a resumed chunk', async () => {
    vi.useFakeTimers();
    try {
      const socket = client<C>()(connect('wss://test'), stream({ timeout: 1000 }), reconnection());
      socket.connect();
      const first = MockWebSocket.last();
      first.open();
      const { handle } = await start(socket, first, { streamKind: 'persistent' });

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

  it('keeps a resumed stream alive after a resume __streamOk__ even when the first chunk is slow', async () => {
    vi.useFakeTimers();
    try {
      const socket = client<C>()(connect('wss://test'), stream({ timeout: 1000 }), reconnection());
      socket.connect();
      const first = MockWebSocket.last();
      first.open();
      const { handle, sid } = await start(socket, first, { streamKind: 'persistent' });

      first.serverClose(1006, 'drop');
      vi.advanceTimersByTime(500);
      const second = MockWebSocket.last();
      second.open();

      second.emit({
        event: '__streamOk__',
        payload: {},
        __wskit: { streamId: sid, streamKind: 'persistent' },
      });

      // Advance well past the 30s resume deadline with no chunk: the acked stream
      // must NOT be aborted by the now-stale deadline.
      await vi.advanceTimersByTimeAsync(31_000);

      second.emit({
        event: 'ask-ai',
        payload: { text: 'late' },
        __wskit: { streamId: sid, seq: 1 },
      });
      second.emit({ event: '__streamEnd__', payload: {}, __wskit: { streamId: sid } });

      await expect(collect(handle)).resolves.toEqual([{ text: 'late' }]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('resumable stream without keepalive warns in debug mode', () => {
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

      await start(socket, ws, { streamKind: 'persistent' });
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

      await start(socket, ws, { streamKind: 'persistent' });
      expect(warnedAboutKeepalive(warn)).toBe(false);
      socket.disconnect();
    } finally {
      warn.mockRestore();
    }
  });

  it('does not warn for an ephemeral (non-resumable) stream', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const socket = client<C>()(connect('wss://test'), stream());
      socket.setDebug(true);
      socket.connect();
      const ws = MockWebSocket.last();
      ws.open();

      await start(socket, ws, { streamKind: 'ephemeral' });
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
