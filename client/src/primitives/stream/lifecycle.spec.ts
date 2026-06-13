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

      // Reconnect.
      vi.advanceTimersByTime(1500);
      const second = MockWebSocket.last();
      second.open();

      // More chunks arrive after resume.
      second.emit({ event: 'ask-ai', payload: { text: 'b' }, __wskit: { streamId: sid, seq: 2 } });
      second.emit({ event: '__streamEnd__', payload: {}, __wskit: { streamId: sid } });

      // The for-await loop should have received both chunks without throwing.
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

      // Drop the connection: the stream is kept for the reconnect window.
      first.serverClose(1006, 'drop');

      // Cancel while reconnecting — the frame can't go out yet, so it's held and the
      // local handle must NOT be torn down (its durable row is still alive server-side).
      handle.cancel();
      expect(handle.active).toBe(true);

      // Reconnect: the held cancel flushes and no __resumeStream__ is sent.
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

      // The stream loop ends cleanly (cancel ends without throwing) and the lazy
      // hold is released exactly once.
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

      // An unrelated lazy consumer (a broadcast-stream subscriber) holds a count.
      const unrelated = socket.onStream('ask-ai', { onChunk: () => undefined });

      // Two durable streams start, each taking a hold.
      const a = await start(socket, first, { streamKind: 'persistent' });
      const b = await start(socket, first, { streamKind: 'persistent' });
      const baseline = (socket as unknown as WSKitSocket)._lazyConsumers;
      expect(baseline).toBe(3); // unrelated + 2 streams

      // Drop, then several failed reconnect attempts each fire onClose before opening.
      first.serverClose(1006, 'drop');
      vi.advanceTimersByTime(1500);
      MockWebSocket.last().serverClose(1006, 'still down');
      vi.advanceTimersByTime(3000);
      MockWebSocket.last().serverClose(1006, 'still down');

      // After repeated closes, each kept stream released its single hold exactly
      // once — the count dropped by 2 (the streams), not more.
      expect((socket as unknown as WSKitSocket)._lazyConsumers).toBe(1); // only unrelated remains

      // A successful reconnect re-acquires both stream holds.
      vi.advanceTimersByTime(6000);
      const reopened = MockWebSocket.last();
      reopened.open();
      expect((socket as unknown as WSKitSocket)._lazyConsumers).toBe(3);

      // End both streams; the unrelated consumer keeps its count.
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

    // The primitive must have re-sent a __resumeStream__ frame.
    const frames = ws.sentFrames();
    const resumeFrame = frames.find(
      (f) => f.event === '__resumeStream__' && f.__wskit.streamId === sid,
    );
    expect(resumeFrame).toBeDefined();

    // The stream is still alive — deliver more chunks and close cleanly.
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

      // Start an ephemeral stream (default).
      const { handle, sid } = await start(socket, first, { streamKind: 'ephemeral' });

      // Collect in background — will throw Disconnected.
      const collectPromise = collect(handle);

      // Drop the connection unexpectedly.
      first.serverClose(1006, 'drop');

      // Ephemeral streams must throw Disconnected.
      await expect(collectPromise).rejects.toMatchObject({ code: 'disconnected' });

      // Reconnect and verify no __resumeStream__ is sent.
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

describe('__error__ with correlationId/ackId passthrough', () => {
  it('leaves the stream running when __error__ carries a correlationId', async () => {
    const { socket, ws } = build();
    const { handle, sid } = await start(socket, ws, { streamKind: 'persistent' });

    socket.onError(() => {});
    // __error__ with a correlationId belongs to another primitive — stream must ignore it.
    ws.emit({
      event: '__error__',
      payload: { code: 'not-found' },
      __wskit: { streamId: sid, correlationId: 'req-abc' },
    });

    // Stream is still alive — chunks should still arrive.
    ws.emit({ event: 'ask-ai', payload: { text: 'a' }, __wskit: { streamId: sid, seq: 1 } });
    ws.emit({ event: '__streamEnd__', payload: {}, __wskit: { streamId: sid } });

    expect(await collect(handle)).toEqual([{ text: 'a' }]);
  });

  it('leaves the stream running when __error__ carries an ackId', async () => {
    const { socket, ws } = build();
    const { handle, sid } = await start(socket, ws, { streamKind: 'persistent' });

    socket.onError(() => {});
    ws.emit({
      event: '__error__',
      payload: { code: 'not-found' },
      __wskit: { streamId: sid, ackId: 'ack-xyz' },
    });

    ws.emit({ event: 'ask-ai', payload: { text: 'a' }, __wskit: { streamId: sid, seq: 1 } });
    ws.emit({ event: '__streamEnd__', payload: {}, __wskit: { streamId: sid } });

    expect(await collect(handle)).toEqual([{ text: 'a' }]);
  });
});

describe('resumeStream reuse branch', () => {
  it('reuses existing state when resumeStream is called twice for the same id', async () => {
    const { socket, ws } = build();

    // First call creates the state and acquires a lazy hold.
    const handleA = socket.resumeStream('ask-ai', 'feed-1', { lastKnownSeq: 0 });

    // Second call for the same id must reuse the existing state — no new lazy hold.
    socket.resumeStream('ask-ai', 'feed-1', { lastKnownSeq: 0 });

    // Only one lazyAcquire was called (for the first resumeStream); the second reused state.
    // If a second lazyAcquire fired, _lazyConsumers would be 2, not 1.
    expect((socket as unknown as WSKitSocket)._lazyConsumers).toBe(1);

    // The original handle's loop drains chunks — proving both calls share the same queue.
    ws.emit({ event: 'ask-ai', payload: { text: 'x' }, __wskit: { streamId: 'feed-1', seq: 1 } });
    ws.emit({ event: '__streamEnd__', payload: {}, __wskit: { streamId: 'feed-1' } });

    expect(await collect(handleA)).toEqual([{ text: 'x' }]);
  });

  it('reuses state for a stream already created by __streamOk__', async () => {
    const { socket, ws } = build();
    const { handle, sid } = await start(socket, ws, { streamKind: 'persistent' });

    // After start(), exactly one lazy hold is live (from triggerStream).
    const consumersAfterStart = (socket as unknown as WSKitSocket)._lazyConsumers;

    // resumeStream for the same id must reuse the existing state — no new lazy hold.
    socket.resumeStream('ask-ai', sid, { lastKnownSeq: 0 });

    // lazyAcquire must NOT have been called again; the consumer count stays the same.
    expect((socket as unknown as WSKitSocket)._lazyConsumers).toBe(consumersAfterStart);

    // Chunks delivered after resumeStream arrive on the original handle's queue,
    // proving the same StreamState (and its queue) was reused.
    ws.emit({ event: 'ask-ai', payload: { text: 'z' }, __wskit: { streamId: sid, seq: 1 } });
    ws.emit({ event: '__streamEnd__', payload: {}, __wskit: { streamId: sid } });

    expect(await collect(handle)).toEqual([{ text: 'z' }]);
  });
});

describe('resumeStream default lastKnownSeq from state', () => {
  it('sends payload {} when no chunk has been delivered and no lastKnownSeq is given', () => {
    const { socket, ws } = build();

    // No chunks received yet — lastSeq is NEGATIVE_INFINITY (not finite).
    socket.resumeStream('ask-ai', 'feed-fresh');

    const frame = ws.sentFrames().at(-1);
    expect(frame).toEqual({
      event: '__resumeStream__',
      payload: {},
      __wskit: { streamId: 'feed-fresh' },
    });
  });

  it('uses the state-derived seq when reconnect-resume omits an explicit lastKnownSeq', async () => {
    vi.useFakeTimers();
    try {
      const socket = client<C>()(connect('wss://test'), stream(), reconnection());
      socket.connect();
      const first = MockWebSocket.last();
      first.open();

      const { sid } = await start(socket, first, { streamKind: 'persistent' });
      // Deliver a chunk so lastSeq = 3.
      first.emit({ event: 'ask-ai', payload: { text: 'a' }, __wskit: { streamId: sid, seq: 3 } });

      first.serverClose(1006, 'drop');
      vi.advanceTimersByTime(1500);
      const second = MockWebSocket.last();
      second.open();

      // On reconnect, the primitive derives lastKnownSeq from state.lastSeq (3).
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
    // A lazy socket — _lazyConsumers tracks who is keeping it alive.
    const socket = client<C>()(connect('wss://test', { lazy: true }), stream());
    socket.connect();
    const ws = MockWebSocket.last();
    ws.open();

    // Start a persistent (resumable) stream.
    await start(socket, ws, { streamKind: 'persistent' });

    // Exactly one lazy hold acquired by triggerStream.
    expect((socket as unknown as WSKitSocket)._lazyConsumers).toBe(1);

    // Server drops the connection unexpectedly — no reconnection primitive is
    // registered, so the socket stays closed permanently.
    ws.serverClose(1006, 'drop');

    // The stream is dead: the socket cannot reconnect, so the hold MUST be
    // released. Today it stays stuck at 1 for resumable streams.
    expect((socket as unknown as WSKitSocket)._lazyConsumers).toBe(0);
  });
});

describe('per-chunk timeout must not start at reconnect for a resumed stream', () => {
  it('does not abort a resumable stream with Timeout while waiting for the first resumed chunk after reconnect', async () => {
    vi.useFakeTimers();
    try {
      // Use a short timeout so the test can advance time without waiting real ms.
      const socket = client<C>()(connect('wss://test'), stream({ timeout: 1000 }), reconnection());
      socket.connect();
      const first = MockWebSocket.last();
      first.open();

      const { handle, sid } = await start(socket, first, { streamKind: 'persistent' });

      // Deliver one chunk, then drop the connection before any more arrive.
      first.emit({ event: 'ask-ai', payload: { text: 'a' }, __wskit: { streamId: sid, seq: 1 } });
      first.serverClose(1006, 'drop');

      // Reconnect.
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

      // Now deliver the first resumed chunk.
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
        stream({ timeout: 0 }), // no per-chunk timer: only the close path can settle it
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
      await Promise.resolve(); // park the for-await on the queue

      // Drop, fire the one retry, then drop the retry BEFORE it opens so the
      // attempt counter is never reset — reconnection exhausts maxAttempts and
      // calls failReconnect(), which must finish the kept stream.
      first.serverClose(1006, 'drop');
      await vi.advanceTimersByTimeAsync(1500);
      const second = MockWebSocket.last();
      second.serverClose(1006, 'retry failed');

      expect(socket.getState()).toBe('closed');
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

    ws.serverClose(4001, 'policy'); // non-retryable → reconnection gives up at once

    expect(socket.getState()).toBe('closed');
    expect(await drained).toMatchObject({ code: 'disconnected' });
  });
});

describe('stream teardown, pre-open triggers, and resume deadline', () => {
  it('a resumable stream ends with Disconnected on an unexpected drop when no reconnection is installed', async () => {
    const { socket, ws } = build(); // no reconnection() — an unexpected drop is terminal
    const { handle } = await start(socket, ws, { streamKind: 'persistent' });

    const drained = collect(handle);
    await Promise.resolve(); // let the for-await park on the queue
    ws.serverClose(1006, 'drop');

    await expect(drained).rejects.toMatchObject({ code: 'disconnected' });
  });

  it('flushes a stream() trigger that was sent before the socket opened', async () => {
    const socket = client<C>()(connect('wss://test', { lazy: true }), stream({ timeout: 0 }));
    const promise = socket.stream('ask-ai', { prompt: 'hi' });

    const ws = MockWebSocket.last(); // created by the lazy connect, not open yet
    expect(ws.sentFrames()).toEqual([]); // held, not dropped

    ws.open(); // onOpen flushes the held trigger
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
      second.open(); // onReconnect sends __resumeStream__ and arms the resume deadline

      // Capture the rejection up front so it can't surface as an unhandled one.
      const drained = collect(handle).then(
        () => null,
        (error) => error,
      );
      // No resumed chunk ever arrives; the resume deadline must end the stream.
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
      second.open(); // onReconnect sends __resumeStream__ and arms the 30s resume deadline

      // The server acks the resume — proof the stream is alive — but the producer
      // is slow, so no chunk arrives yet. The resume deadline must be dropped.
      second.emit({
        event: '__streamOk__',
        payload: {},
        __wskit: { streamId: sid, streamKind: 'persistent' },
      });

      // Advance well past the 30s resume deadline with no chunk: the acked stream
      // must NOT be aborted by the now-stale deadline.
      await vi.advanceTimersByTimeAsync(31_000);

      // The slow first chunk and a clean end finally arrive.
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
