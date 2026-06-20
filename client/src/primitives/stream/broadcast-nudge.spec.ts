import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { channels } from '~/primitives/channels/index.ts';
import { stream } from '~/primitives/stream/index.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamOptions } from '~/primitives/stream/index.ts';
import type { StreamHandle } from '~/types.ts';

interface C {
  streams: {
    'ask-ai': {
      payload: { prompt: string };
      chunk: { text: string };
      nudges: { hint: { value: string } };
    };
    'feed-b': {
      payload: { topic: string };
      chunk: { text: string };
    };
  };
  channels: {
    rooms: {
      addressing: 'dynamic';
      incoming: { msg: { text: string } };
      outgoing: { say: { text: string } };
      streams: { 'ask-ai': { payload: { prompt: string }; chunk: { text: string } } };
    };
  };
}

function buildWithStream(opts?: StreamOptions) {
  const socket = client<C>()(connect('wss://test'), stream(opts));
  socket.connect();
  const ws = MockWebSocket.last();
  ws.open();
  return { socket, ws };
}

function buildWithStreamAndChannels(opts?: StreamOptions) {
  const socket = client<C>()(connect('wss://test'), stream(opts), channels());
  socket.connect();
  const ws = MockWebSocket.last();
  ws.open();
  return { socket, ws };
}

type AiHandle = StreamHandle<{ text: string }, { hint: { value: string } }>;
type StreamSocket = ReturnType<typeof buildWithStream>['socket'];

async function start(
  socket: StreamSocket,
  ws: MockWebSocket,
  options?: { streamKind?: 'ephemeral' | 'persistent' },
): Promise<{ handle: AiHandle; sid: string }> {
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

let restore: () => void;
beforeEach(() => {
  restore = installMockWebSocket();
});
afterEach(() => {
  restore();
  vi.useRealTimers();
});

describe('nudge timeout', () => {
  it('rejects the nudge promise with Timeout when no __nudgeOk__ arrives within nudgeTimeout', async () => {
    vi.useFakeTimers();
    const { socket, ws } = buildWithStream({ nudgeTimeout: 500 });
    const { handle } = await start(socket, ws);

    const pending = handle.nudge('hint', { value: 'test' });
    vi.advanceTimersByTime(500);

    await expect(pending).rejects.toMatchObject({ code: 'timeout' });
  });

  it('removes the pending nudge entry after timeout so a late __nudgeOk__ is ignored', async () => {
    vi.useFakeTimers();
    const { socket, ws } = buildWithStream({ nudgeTimeout: 500 });
    const { handle, sid } = await start(socket, ws);

    const pending = handle.nudge('hint', { value: 'test' });
    const nudgeId = ws.sentFrames().at(-1).__wskit.streamNudgeId as string;
    vi.advanceTimersByTime(500);

    await expect(pending).rejects.toMatchObject({ code: 'timeout' });

    // Late __nudgeOk__ after the timer fired must not reject or resolve anything extra.
    // If the pending entry was deleted correctly, this is a no-op.
    expect(() =>
      ws.emit({
        event: '__nudgeOk__',
        payload: {},
        __wskit: { streamId: sid, streamNudgeId: nudgeId },
      }),
    ).not.toThrow();

    expect(handle.active).toBe(true);
  });
});

describe('trigger handshake timeout', () => {
  it('rejects the stream() promise with Timeout when __streamOk__ never arrives', async () => {
    vi.useFakeTimers();
    const { socket } = buildWithStream({ timeout: 1000 });

    const promise = socket.stream('ask-ai', { prompt: 'hi' });
    vi.advanceTimersByTime(1000);

    await expect(promise).rejects.toMatchObject({ code: 'timeout' });
  });

  it('does not leave a stale trigger entry after handshake timeout', async () => {
    vi.useFakeTimers();
    const { socket, ws } = buildWithStream({ timeout: 1000 });

    const promise = socket.stream('ask-ai', { prompt: 'hi' });
    const sid = ws.sentFrames().at(-1).__wskit.streamId as string;
    vi.advanceTimersByTime(1000);

    await expect(promise).rejects.toMatchObject({ code: 'timeout' });

    expect(() =>
      ws.emit({
        event: '__streamOk__',
        payload: {},
        __wskit: { streamId: sid, streamKind: 'ephemeral' },
      }),
    ).not.toThrow();
  });
});

describe('nudge after stream ends', () => {
  it('resolves immediately without sending a frame when nudged after __streamEnd__', async () => {
    const { socket, ws } = buildWithStream();
    const { handle, sid } = await start(socket, ws);

    ws.emit({ event: '__streamEnd__', payload: {}, __wskit: { streamId: sid } });
    const chunks: unknown[] = [];
    for await (const chunk of handle) chunks.push(chunk);

    const frameCountBefore = ws.sentFrames().length;
    await expect(handle.nudge('hint', { value: 'ignored' })).resolves.toBeUndefined();
    expect(ws.sentFrames().length).toBe(frameCountBefore);
  });

  it('resolves immediately without sending a frame when nudged after cancel()', async () => {
    const { socket, ws } = buildWithStream();
    const { handle } = await start(socket, ws);

    handle.cancel();
    const frameCountAfterCancel = ws.sentFrames().length;

    await expect(handle.nudge('hint', { value: 'ignored' })).resolves.toBeUndefined();
    expect(ws.sentFrames().length).toBe(frameCountAfterCancel);
  });
});

describe('cancel idempotency after stream ends', () => {
  it('does not send a second __streamCancel__ when cancel() is called twice', async () => {
    const { socket, ws } = buildWithStream();
    const { handle } = await start(socket, ws);

    handle.cancel();
    const frames = ws.sentFrames();
    const cancelCount = frames.filter((f) => f.event === '__streamCancel__').length;
    expect(cancelCount).toBe(1);

    handle.cancel();
    const framesAfter = ws.sentFrames();
    const cancelCountAfter = framesAfter.filter((f) => f.event === '__streamCancel__').length;
    expect(cancelCountAfter).toBe(1);
  });

  it('does not send __streamCancel__ when cancel() is called after __streamEnd__', async () => {
    const { socket, ws } = buildWithStream();
    const { handle, sid } = await start(socket, ws);

    ws.emit({ event: '__streamEnd__', payload: {}, __wskit: { streamId: sid } });
    for await (const _chunk of handle) {
      void _chunk;
    }

    const frameCountBefore = ws.sentFrames().length;
    handle.cancel();
    expect(ws.sentFrames().length).toBe(frameCountBefore);
  });

  it('does not send __streamCancel__ when the iterator return() is called on a finished stream', async () => {
    const { socket, ws } = buildWithStream();
    const { handle, sid } = await start(socket, ws);

    ws.emit({ event: '__streamEnd__', payload: {}, __wskit: { streamId: sid } });
    for await (const _chunk of handle) {
      void _chunk;
    }

    const frameCountBefore = ws.sentFrames().length;
    const iter = handle[Symbol.asyncIterator]();
    await iter.return?.();
    expect(ws.sentFrames().length).toBe(frameCountBefore);
  });
});

describe('broadcast scope and seq deduplication', () => {
  it('does not deliver a top-level broadcast chunk to a channel-scoped onStream subscriber', async () => {
    const { socket, ws } = buildWithStreamAndChannels();

    const room = socket.channel('rooms', 'r1');
    const sub = room.subscribe();
    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      __wskit: { source: 'client', channel: 'r1', channelFamily: 'rooms' },
    });
    await sub;

    const onChunk = vi.fn();
    room.onStream('ask-ai', { onChunk });

    ws.emit({ event: 'ask-ai', payload: { text: 'hi' }, __wskit: { streamId: 'bs1', seq: 1 } });

    expect(onChunk).not.toHaveBeenCalled();
  });

  it('does not deliver a channel-scoped broadcast chunk to a top-level onStream subscriber', async () => {
    const { socket, ws } = buildWithStreamAndChannels();

    const onChunk = vi.fn();
    socket.onStream('ask-ai', { onChunk });

    ws.emit({
      event: 'ask-ai',
      payload: { text: 'scoped' },
      __wskit: { streamId: 'bs2', seq: 1, channel: 'r1', channelFamily: 'rooms' },
    });

    expect(onChunk).not.toHaveBeenCalled();
  });

  it('drops a broadcast chunk whose seq is <= the last delivered seq', () => {
    const { socket, ws } = buildWithStream();
    const onChunk = vi.fn();
    socket.onStream('ask-ai', { onChunk });

    ws.emit({ event: 'ask-ai', payload: { text: 'a' }, __wskit: { streamId: 'bs3', seq: 3 } });
    ws.emit({ event: 'ask-ai', payload: { text: 'b' }, __wskit: { streamId: 'bs3', seq: 2 } });
    ws.emit({ event: 'ask-ai', payload: { text: 'c' }, __wskit: { streamId: 'bs3', seq: 3 } });

    expect(onChunk).toHaveBeenCalledTimes(1);
    expect(onChunk).toHaveBeenCalledWith({ text: 'a' }, 'bs3');
  });

  it('fires onTimeout when no broadcast chunk arrives within the per-chunk timeout', () => {
    vi.useFakeTimers();
    const { socket, ws } = buildWithStream({ timeout: 800 });
    const onTimeout = vi.fn();
    socket.onStream('ask-ai', { onChunk: () => {}, onTimeout });

    ws.emit({ event: 'ask-ai', payload: { text: 'first' }, __wskit: { streamId: 'bs4', seq: 1 } });
    vi.advanceTimersByTime(800);

    expect(onTimeout).toHaveBeenCalledWith('bs4');
  });
});

describe('late onStream subscriber receives subsequent chunks', () => {
  it('subscriber added after first chunk receives later chunks', () => {
    const { socket, ws } = buildWithStream();

    const firstChunks = vi.fn();
    const lateChunks = vi.fn();

    socket.onStream('ask-ai', { onChunk: firstChunks });

    ws.emit({
      event: 'ask-ai',
      payload: { text: 'chunk1' },
      __wskit: { streamId: 'bsf1', seq: 1 },
    });
    expect(firstChunks).toHaveBeenCalledTimes(1);

    socket.onStream('ask-ai', { onChunk: lateChunks });

    ws.emit({
      event: 'ask-ai',
      payload: { text: 'chunk2' },
      __wskit: { streamId: 'bsf1', seq: 2 },
    });

    expect(firstChunks).toHaveBeenCalledTimes(2);
    expect(lateChunks).toHaveBeenCalledTimes(1);
    expect(lateChunks).toHaveBeenCalledWith({ text: 'chunk2' }, 'bsf1');
  });
});

describe('pre-chunk error/end fires onError and onEnd', () => {
  it('onEnd fires when __streamEnd__ arrives before any chunk', () => {
    const { socket, ws } = buildWithStream();

    const onEnd = vi.fn();
    socket.onStream('ask-ai', { onChunk: vi.fn(), onEnd });

    ws.emit({
      event: '__streamEnd__',
      payload: {},
      __wskit: { streamId: 'bsne1', eventName: 'ask-ai' },
    });

    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('onError fires when __error__ arrives before any chunk', () => {
    const { socket, ws } = buildWithStream();

    const onError = vi.fn();
    socket.onStream('ask-ai', { onChunk: vi.fn(), onError });

    ws.emit({
      event: '__error__',
      payload: { code: 'stream-ended', message: 'ended' },
      __wskit: { streamId: 'bsne2', eventName: 'ask-ai' },
    });

    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe('deliverBroadcast with no matching scope', () => {
  it('does not fire onEnd on a mismatched-scope subscriber when __streamEnd__ arrives', async () => {
    const { socket, ws } = buildWithStreamAndChannels();

    const room = socket.channel('rooms', 'r1');
    const sub = room.subscribe();
    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      __wskit: { source: 'client', channel: 'r1', channelFamily: 'rooms' },
    });
    await sub;

    const onChunk = vi.fn();
    const onEnd = vi.fn();
    // Subscribe at channel scope — this subscriber must NOT receive top-level chunks.
    room.onStream('ask-ai', { onChunk, onEnd });

    ws.emit({ event: 'ask-ai', payload: { text: 'x' }, __wskit: { streamId: 'bs5', seq: 1 } });
    expect(onChunk).not.toHaveBeenCalled();

    ws.emit({ event: '__streamEnd__', payload: {}, __wskit: { streamId: 'bs5' } });
    expect(onEnd).not.toHaveBeenCalled();
  });

  it('does not register a broadcastRun when no subscriber scope matches', async () => {
    const { socket, ws } = buildWithStreamAndChannels();

    const room = socket.channel('rooms', 'r1');
    const sub = room.subscribe();
    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      __wskit: { source: 'client', channel: 'r1', channelFamily: 'rooms' },
    });
    await sub;

    const onChunk = vi.fn();
    const onEnd = vi.fn();
    room.onStream('ask-ai', { onChunk, onEnd });

    ws.emit({ event: 'ask-ai', payload: { text: 'x' }, __wskit: { streamId: 'bs6', seq: 1 } });
    expect(onChunk).not.toHaveBeenCalled();

    ws.emit({ event: '__streamEnd__', payload: {}, __wskit: { streamId: 'bs6' } });
    expect(onEnd).not.toHaveBeenCalled();
  });
});

describe('broadcast terminal-frame routing (eventName)', () => {
  it('a terminal frame with no eventName does not fan out to unrelated subscribers', () => {
    const { socket, ws } = buildWithStream();
    const endAskAi = vi.fn();
    const endFeedB = vi.fn();
    socket.onStream('ask-ai', { onChunk: vi.fn(), onEnd: endAskAi });
    socket.onStream('feed-b', { onChunk: vi.fn(), onEnd: endFeedB });

    ws.emit({ event: '__streamEnd__', payload: {}, __wskit: { streamId: 's1' } });

    expect(endAskAi).not.toHaveBeenCalled();
    expect(endFeedB).not.toHaveBeenCalled();
  });

  it('a broadcast terminal frame routes only to its eventName subscribers', () => {
    const { socket, ws } = buildWithStream();
    const endAskAi = vi.fn();
    const endFeedB = vi.fn();
    const errAskAi = vi.fn();
    socket.onStream('ask-ai', { onChunk: vi.fn(), onEnd: endAskAi, onError: errAskAi });
    socket.onStream('feed-b', { onChunk: vi.fn(), onEnd: endFeedB });

    ws.emit({
      event: '__streamEnd__',
      payload: {},
      __wskit: { streamId: 's2', eventName: 'feed-b' },
    });
    expect(endFeedB).toHaveBeenCalledTimes(1);
    expect(endAskAi).not.toHaveBeenCalled();

    ws.emit({
      event: '__error__',
      payload: { code: 'internal-error' },
      __wskit: { streamId: 's3', eventName: 'ask-ai', streamTerminated: true },
    });
    expect(errAskAi).toHaveBeenCalledTimes(1);
  });
});
