import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { StreamCorrupted } from '~/errors.ts';
import { channels } from '~/primitives/channels/index.ts';
import { reconnection } from '~/primitives/reconnection/index.ts';
import { stream } from '~/primitives/stream/index.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface C {
  streams: {
    'ask-ai': { payload: { prompt: string }; chunk: { text: string }; kind: 'persistent' };
  };
  channels: {
    rooms: {
      addressing: 'dynamic';
      streams: { 'ask-ai': { payload: { prompt: string }; chunk: { text: string } } };
    };
  };
}

let restore: () => void;
beforeEach(() => {
  restore = installMockWebSocket();
});
afterEach(() => {
  restore();
});

function build() {
  const socket = client<C>()(connect('wss://test'), stream(), channels(), reconnection());
  socket.connect();
  const ws = MockWebSocket.last();
  ws.open();

  return { socket, ws };
}

const inRoom = { channel: { name: 'room:general', family: 'rooms' } };

function chunk(ws: MockWebSocket, streamId: string, seq: number): void {
  ws.emit({
    event: 'ask-ai',
    payload: { text: `t${seq}` },
    metadata: { stream: { id: streamId, seq } },
  });
}

function roomChunk(ws: MockWebSocket, streamId: string, seq: number): void {
  ws.emit({
    event: 'ask-ai',
    payload: { text: `t${seq}` },
    metadata: { stream: { id: streamId, seq }, ...inRoom },
  });
}

function end(ws: MockWebSocket, streamId: string, seq: number): void {
  ws.emit({ event: '__streamEnd__', payload: null, metadata: { stream: { id: streamId, seq } } });
}

async function startOwn(
  socket: ReturnType<typeof build>['socket'],
  ws: MockWebSocket,
  durability: 'ephemeral' | 'persistent' = 'ephemeral',
) {
  const promise = socket.stream('ask-ai', { prompt: 'hi' });
  const sid = ws.sentFrames().at(-1).metadata.stream?.id as string;
  ws.emit({ event: '__streamOk__', payload: null, metadata: { stream: { id: sid, durability } } });
  return { handle: await promise, sid };
}

function cancels(ws: MockWebSocket): number {
  return ws.sentFrames().filter((frame) => frame.event === '__streamCancel__').length;
}

async function drain(handle: AsyncIterable<{ text: string }>) {
  const texts: string[] = [];
  try {
    for await (const item of handle) texts.push(item.text);
  } catch (error) {
    return { texts, error };
  }

  return { texts, error: undefined };
}

describe('a stream the client started', () => {
  it('fails with StreamCorrupted when a chunk is missing', async () => {
    const { socket, ws } = build();
    const { handle, sid } = await startOwn(socket, ws);

    chunk(ws, sid, 1);
    chunk(ws, sid, 3);
    const { texts, error } = await drain(handle);

    expect(texts).toEqual(['t1']);
    expect(StreamCorrupted.matches(error)).toBe(true);
    expect((error as { detail: unknown }).detail).toEqual({ expected: 2, got: 3 });
    // A plain stream is cancelled, so the server stops sending.
    expect(cancels(ws)).toBe(1);
  });

  it('does not cancel a recorded stream, so continueStream can get the missing chunks', async () => {
    const { socket, ws } = build();
    const { handle, sid } = await startOwn(socket, ws, 'persistent');

    chunk(ws, sid, 1);
    chunk(ws, sid, 3);
    const { error } = await drain(handle);

    expect(StreamCorrupted.matches(error)).toBe(true);
    expect(cancels(ws)).toBe(0);
  });

  it('keeps dropping chunks it has when continueStream asks from an older seq', async () => {
    const { socket, ws } = build();
    const { handle, sid } = await startOwn(socket, ws, 'persistent');

    for (const seq of [1, 2, 3]) chunk(ws, sid, seq);
    socket.continueStream('ask-ai', sid, { lastKnownSeq: 1 });
    for (const seq of [2, 3, 4]) chunk(ws, sid, seq);
    end(ws, sid, 4);

    expect(await drain(handle)).toEqual({ texts: ['t1', 't2', 't3', 't4'], error: undefined });
  });

  it('fails when the first chunk is missing', async () => {
    const { socket, ws } = build();
    const { handle, sid } = await startOwn(socket, ws);

    chunk(ws, sid, 2);
    const { error } = await drain(handle);

    expect((error as { detail: unknown }).detail).toEqual({ expected: 1, got: 2 });
  });

  it('fails when the end frame says a chunk is missing at the end', async () => {
    const { socket, ws } = build();
    const { handle, sid } = await startOwn(socket, ws);

    chunk(ws, sid, 1);
    chunk(ws, sid, 2);
    end(ws, sid, 3);
    const { texts, error } = await drain(handle);

    expect(texts).toEqual(['t1', 't2']);
    expect((error as { detail: unknown }).detail).toEqual({ expected: 3, got: 2 });
  });

  it('still drops a chunk it already has, and ends normally', async () => {
    const { socket, ws } = build();
    const { handle, sid } = await startOwn(socket, ws);

    chunk(ws, sid, 1);
    chunk(ws, sid, 1);
    chunk(ws, sid, 2);
    end(ws, sid, 2);

    expect(await drain(handle)).toEqual({ texts: ['t1', 't2'], error: undefined });
  });

  it('ignores delivery.seq: only stream.seq counts', async () => {
    const { socket, ws } = build();
    const { handle, sid } = await startOwn(socket, ws);

    // Before, a chunk with no stream.seq fell back to delivery.seq 40, so chunk 1 then looked
    // like a duplicate.
    ws.emit({
      event: 'ask-ai',
      payload: { text: 'no-seq' },
      metadata: { stream: { id: sid }, delivery: { seq: 40 } },
    });
    chunk(ws, sid, 1);
    end(ws, sid, 1);

    expect(await drain(handle)).toEqual({ texts: ['no-seq', 't1'], error: undefined });
  });
});

describe('a continued recorded stream', () => {
  it('expects lastKnownSeq + 1 first', async () => {
    const { socket, ws } = build();
    const handle = socket.continueStream('ask-ai', 'reply-1', { lastKnownSeq: 5 });

    chunk(ws, 'reply-1', 7);
    const { error } = await drain(handle);

    expect((error as { detail: unknown }).detail).toEqual({ expected: 6, got: 7 });
  });

  it('accepts lastKnownSeq + 1', async () => {
    const { socket, ws } = build();
    const handle = socket.continueStream('ask-ai', 'reply-1', { lastKnownSeq: 5 });

    chunk(ws, 'reply-1', 6);
    end(ws, 'reply-1', 6);

    expect(await drain(handle)).toEqual({ texts: ['t6'], error: undefined });
  });
});

describe('a broadcast stream heard with onStream', () => {
  function listen(socket: ReturnType<typeof build>['socket']) {
    const chunks: string[] = [];
    const errors: unknown[] = [];
    const room = socket.channel('rooms', 'room:general');
    room.onStream('ask-ai', {
      onChunk: (payload) => chunks.push(payload.text),
      onError: (error) => errors.push(error),
    });

    return { chunks, errors };
  }

  it('starts from any first chunk, then fails the run on a gap', () => {
    const { socket, ws } = build();
    const { chunks, errors } = listen(socket);

    roomChunk(ws, 'b1', 4);
    roomChunk(ws, 'b1', 5);
    roomChunk(ws, 'b1', 7);

    expect(chunks).toEqual(['t4', 't5']);
    expect(errors).toHaveLength(1);
    expect((errors[0] as { detail: unknown }).detail).toEqual({ expected: 6, got: 7 });
  });

  it('starts the gap check again after a reconnect, and still drops a chunk sent again', () => {
    vi.useFakeTimers();
    try {
      const { socket, ws } = build();
      const { chunks, errors } = listen(socket);

      roomChunk(ws, 'b1', 4);
      ws.serverClose(1006);
      vi.advanceTimersByTime(60_000);
      const next = MockWebSocket.last();
      next.open();

      roomChunk(next, 'b1', 4);
      roomChunk(next, 'b1', 9);
      roomChunk(next, 'b1', 10);

      expect(chunks).toEqual(['t4', 't9', 't10']);
      expect(errors).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts the gap check again after the member joins the channel again', () => {
    const { socket, ws } = build();
    const { chunks, errors } = listen(socket);

    roomChunk(ws, 'b1', 4);
    ws.emit({ event: '__subscribeOk__', payload: null, metadata: inRoom });
    roomChunk(ws, 'b1', 9);

    expect(chunks).toEqual(['t4', 't9']);
    expect(errors).toEqual([]);
  });

  it('drops the rest of a run that failed on a gap, including its end', () => {
    const { socket, ws } = build();
    const { chunks, errors } = listen(socket);
    const ends: string[] = [];
    socket.channel('rooms', 'room:general').onStream('ask-ai', {
      onChunk: () => {},
      onEnd: (id) => ends.push(id),
    });

    for (const seq of [4, 5, 7, 8]) roomChunk(ws, 'b1', seq);
    ws.emit({
      event: '__streamEnd__',
      payload: null,
      metadata: { stream: { id: 'b1', seq: 8, event: 'ask-ai' }, ...inRoom },
    });

    expect(chunks).toEqual(['t4', 't5']);
    expect(errors).toHaveLength(1);
    expect(ends).toEqual([]);
  });

  it('fails the run when the end frame says a chunk is missing at the end', () => {
    const { socket, ws } = build();
    const { chunks, errors } = listen(socket);

    roomChunk(ws, 'b1', 4);
    roomChunk(ws, 'b1', 5);
    ws.emit({
      event: '__streamEnd__',
      payload: null,
      metadata: { stream: { id: 'b1', seq: 6, event: 'ask-ai' }, ...inRoom },
    });

    expect(chunks).toEqual(['t4', 't5']);
    expect((errors[0] as { detail: unknown }).detail).toEqual({ expected: 6, got: 5 });
  });
});
