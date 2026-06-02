import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { channels } from '~/primitives/channels/index.ts';
import { reconnection } from '~/primitives/reconnection.ts';
import { stream } from '~/primitives/stream/index.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamHandle } from '~/types.ts';

interface C {
  streams: {
    'ask-ai': {
      payload: { prompt: string };
      chunks: { text: string };
      nudges: { cancel: { reason: string }; 'add-context': { context: string } };
    };
  };
  channels: {
    rooms: {
      [r: string]: {
        incoming: { msg: { text: string } };
        outgoing: { say: { text: string } };
        streams: { 'ask-ai': { payload: { prompt: string }; chunks: { text: string } } };
      };
    };
  };
}

// oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test helper
function build(...primitives: any[]) {
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test helper
  const socket = (client<C>() as any)(connect('wss://test'), ...primitives);
  socket.connect();
  const ws = MockWebSocket.last();
  ws.open();
  return { socket, ws };
}

type AskAiHandle = StreamHandle<
  { text: string },
  { cancel: { reason: string }; 'add-context': { context: string } }
>;

/** Trigger a stream and complete the server's __streamOk__ handshake. */
async function start(
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test helper
  socket: any,
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

describe('triggering and iterating', () => {
  it('resolves on __streamOk__ and yields chunks until __streamEnd__', async () => {
    const { socket, ws } = build(stream());
    const { handle, sid } = await start(socket, ws);
    ws.emit({ event: 'ask-ai', payload: { text: 'a' }, __wskit: { streamId: sid, seq: 1 } });
    ws.emit({ event: 'ask-ai', payload: { text: 'b' }, __wskit: { streamId: sid, seq: 2 } });
    ws.emit({ event: '__streamEnd__', payload: {}, __wskit: { streamId: sid } });
    expect(await collect(handle)).toEqual([{ text: 'a' }, { text: 'b' }]);
  });

  it('drops chunks already delivered (per-seq dedup)', async () => {
    const { socket, ws } = build(stream());
    const { handle, sid } = await start(socket, ws);
    ws.emit({ event: 'ask-ai', payload: { text: 'a' }, __wskit: { streamId: sid, seq: 1 } });
    ws.emit({ event: 'ask-ai', payload: { text: 'a' }, __wskit: { streamId: sid, seq: 1 } }); // dup
    ws.emit({ event: 'ask-ai', payload: { text: 'b' }, __wskit: { streamId: sid, seq: 2 } });
    ws.emit({ event: '__streamEnd__', payload: {}, __wskit: { streamId: sid } });
    expect(await collect(handle)).toEqual([{ text: 'a' }, { text: 'b' }]);
  });

  it('throws a typed error when the server sends __error__', async () => {
    const { socket, ws } = build(stream());
    const { handle, sid } = await start(socket, ws);
    ws.emit({
      event: '__error__',
      payload: { code: 'quota-exceeded', detail: { limit: 5 } },
      __wskit: { streamId: sid },
    });
    await expect(collect(handle)).rejects.toMatchObject({
      code: 'quota-exceeded',
      detail: { limit: 5 },
    });
  });

  it('rejects the stream() promise on an error that arrives before __streamOk__', async () => {
    const { socket, ws } = build(stream());
    const promise = socket.stream('ask-ai', { prompt: 'hi' });
    const sid = ws.sentFrames().at(-1).__wskit.streamId as string;
    ws.emit({
      event: '__error__',
      payload: { code: 'stream-already-active' },
      __wskit: { streamId: sid },
    });
    await expect(promise).rejects.toMatchObject({ code: 'stream-already-active' });
  });

  it('throws Disconnected when the socket disconnects mid-stream', async () => {
    const { socket, ws } = build(stream());
    const { handle } = await start(socket, ws);
    socket.disconnect();
    await expect(collect(handle)).rejects.toMatchObject({ code: 'disconnected' });
  });

  it('throws Timeout when no chunk arrives in time', async () => {
    vi.useFakeTimers();
    try {
      const { socket, ws } = build(stream({ timeout: 1000 }));
      const { handle } = await start(socket, ws);
      vi.advanceTimersByTime(1000);
      await expect(collect(handle)).rejects.toMatchObject({ code: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('nudge and cancel', () => {
  it('sends a nudge tagged with the stream id and resolves on __nudgeOk__', async () => {
    const { socket, ws } = build(stream());
    const { handle, sid } = await start(socket, ws);
    const pending = handle.nudge('add-context', { context: 'ocean' });
    const frame = ws.sentFrames().at(-1);
    expect(frame).toEqual({
      event: 'add-context',
      payload: { context: 'ocean' },
      __wskit: { streamId: sid, streamNudgeId: expect.any(String) },
    });
    ws.emit({
      event: '__nudgeOk__',
      payload: {},
      __wskit: { streamId: sid, streamNudgeId: frame.__wskit.streamNudgeId },
    });
    await expect(pending).resolves.toBeUndefined();
  });

  it('rejects the nudge() Promise on a non-terminal error without ending the stream', async () => {
    const { socket, ws } = build(stream());
    const { handle, sid } = await start(socket, ws);
    const pending = handle.nudge('add-context', { context: 'ocean' });
    const streamNudgeId = ws.sentFrames().at(-1).__wskit.streamNudgeId as string;
    ws.emit({
      event: '__error__',
      payload: { code: 'validation-failed' },
      __wskit: { streamId: sid, streamNudgeId, streamTerminated: false },
    });
    await expect(pending).rejects.toMatchObject({ code: 'validation-failed' });
    // The stream is still running: a chunk after the rejected nudge still arrives.
    ws.emit({ event: 'ask-ai', payload: { text: 'a' }, __wskit: { streamId: sid, seq: 1 } });
    ws.emit({ event: '__streamEnd__', payload: {}, __wskit: { streamId: sid } });
    expect(await collect(handle)).toEqual([{ text: 'a' }]);
  });

  it('cancel() sends __streamCancel__ and ends the loop without throwing', async () => {
    const { socket, ws } = build(stream());
    const { handle, sid } = await start(socket, ws);
    handle.cancel();
    expect(ws.sentFrames().at(-1)).toEqual({
      event: '__streamCancel__',
      payload: {},
      __wskit: { streamId: sid },
    });
    expect(await collect(handle)).toEqual([]);
  });

  it('breaking out of the loop cancels the stream', async () => {
    const { socket, ws } = build(stream());
    const { handle, sid } = await start(socket, ws);
    ws.emit({ event: 'ask-ai', payload: { text: 'a' }, __wskit: { streamId: sid, seq: 1 } });
    for await (const _chunk of handle) {
      void _chunk;
      break;
    }
    expect(ws.sentFrames().at(-1).event).toBe('__streamCancel__');
  });
});

describe('onStream (broadcast)', () => {
  it('fires onChunk then onEnd', () => {
    const { socket, ws } = build(stream());
    const onChunk = vi.fn();
    const onEnd = vi.fn();
    socket.onStream('ask-ai', { onChunk, onEnd });
    ws.emit({ event: 'ask-ai', payload: { text: 'a' }, __wskit: { streamId: 'bs1', seq: 1 } });
    expect(onChunk).toHaveBeenCalledWith({ text: 'a' }, 'bs1');
    ws.emit({ event: '__streamEnd__', payload: {}, __wskit: { streamId: 'bs1', seq: 5 } });
    expect(onEnd).toHaveBeenCalledWith('bs1', 5);
  });

  it('fires onError when the broadcast stream errors', () => {
    const { socket, ws } = build(stream());
    const onError = vi.fn();
    socket.onStream('ask-ai', { onChunk: () => {}, onError });
    ws.emit({ event: 'ask-ai', payload: { text: 'a' }, __wskit: { streamId: 'bs2', seq: 1 } });
    ws.emit({
      event: '__error__',
      payload: { code: 'internal-error' },
      __wskit: { streamId: 'bs2' },
    });
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'internal-error' }),
      'bs2',
    );
  });
});

describe('durable resume', () => {
  it('sends __resumeStream__ with lastKnownSeq after a reconnect', async () => {
    vi.useFakeTimers();
    try {
      const socket = client<C>()(connect('wss://test'), stream(), reconnection());
      socket.connect();
      const first = MockWebSocket.last();
      first.open();
      const { sid } = await start(socket, first, { streamKind: 'persistent' });
      first.emit({ event: 'ask-ai', payload: { text: 'a' }, __wskit: { streamId: sid, seq: 7 } });
      first.serverClose(1006, 'drop');
      vi.advanceTimersByTime(1500);
      const second = MockWebSocket.last();
      second.open();
      expect(second.sentFrames()).toContainEqual({
        event: '__resumeStream__',
        payload: { lastKnownSeq: 7 },
        __wskit: { streamId: sid },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('resumeStream replays chunks into the returned handle and ends on __streamEnd__', async () => {
    const { socket, ws } = build(stream());
    const handle = socket.resumeStream('ask-ai', 'feed-1', { lastKnownSeq: 0 });
    expect(ws.sentFrames().at(-1)).toEqual({
      event: '__resumeStream__',
      payload: { lastKnownSeq: 0 },
      __wskit: { streamId: 'feed-1' },
    });
    ws.emit({ event: 'ask-ai', payload: { text: 'a' }, __wskit: { streamId: 'feed-1', seq: 1 } });
    ws.emit({ event: 'ask-ai', payload: { text: 'b' }, __wskit: { streamId: 'feed-1', seq: 2 } });
    ws.emit({ event: '__streamEnd__', payload: {}, __wskit: { streamId: 'feed-1' } });
    expect(await collect(handle)).toEqual([{ text: 'a' }, { text: 'b' }]);
  });

  it('scoped resumeStream carries the channel markers', async () => {
    const { socket, ws } = build(stream(), channels());
    const room = socket.channel('rooms', 'r1');
    const sub = room.subscribe();
    ws.emit({
      event: '__subscribeOk__',
      payload: { source: 'client' },
      __wskit: { channel: 'r1', channelScope: 'rooms' },
    });
    await sub;
    const handle = room.resumeStream('ask-ai', 'feed-2', { lastKnownSeq: 0 });
    expect(ws.sentFrames().at(-1)).toEqual({
      event: '__resumeStream__',
      payload: { lastKnownSeq: 0 },
      __wskit: { channel: 'r1', channelScope: 'rooms', streamId: 'feed-2' },
    });
    ws.emit({
      event: 'ask-ai',
      payload: { text: 'x' },
      __wskit: { channel: 'r1', channelScope: 'rooms', streamId: 'feed-2', seq: 1 },
    });
    ws.emit({ event: '__streamEnd__', payload: {}, __wskit: { streamId: 'feed-2' } });
    expect(await collect(handle)).toEqual([{ text: 'x' }]);
  });
});

describe('scoped streams', () => {
  it('tags a channel stream trigger with the channel markers', async () => {
    const { socket, ws } = build(stream(), channels());
    const room = socket.channel('rooms', 'r1');
    const sub = room.subscribe();
    ws.emit({
      event: '__subscribeOk__',
      payload: { source: 'client' },
      __wskit: { channel: 'r1', channelScope: 'rooms' },
    });
    await sub;
    void room.stream('ask-ai', { prompt: 'hi' });
    const frame = ws.sentFrames().at(-1);
    expect(frame.event).toBe('ask-ai');
    expect(frame.__wskit).toMatchObject({ channel: 'r1', channelScope: 'rooms' });
    expect(typeof frame.__wskit.streamId).toBe('string');
  });
});
