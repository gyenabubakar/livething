import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
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
