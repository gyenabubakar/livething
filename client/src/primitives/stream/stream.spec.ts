import { StreamAborted, WIRE_LIMITS } from '@livething/core';
import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { channels } from '~/primitives/channels/index.ts';
import { reconnection } from '~/primitives/reconnection/index.ts';
import { stream } from '~/primitives/stream/index.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveThingSocket } from '~/socket/socket.ts';
import type { StreamHandle } from '~/types.ts';

interface C {
  streams: {
    'ask-ai': {
      payload: { prompt: string };
      chunk: { text: string };
      kind: 'persistent';
      nudges: { cancel: { reason: string }; 'add-context': { context: string } };
    };
  };
  channels: {
    rooms: {
      addressing: 'dynamic';
      incoming: { msg: { text: string } };
      outgoing: { say: { text: string } };
      streams: {
        'ask-ai': { payload: { prompt: string }; chunk: { text: string }; kind: 'persistent' };
      };
    };
  };
}

function buildStream(s = stream()) {
  const socket = client<C>()(connect('wss://test'), s);
  socket.connect();
  const ws = MockWebSocket.last();
  ws.open();

  return { socket, ws };
}

function buildStreamChannels() {
  const socket = client<C>()(connect('wss://test'), stream(), channels());
  socket.connect();
  const ws = MockWebSocket.last();
  ws.open();

  return { socket, ws };
}

type AskAiHandle = StreamHandle<
  { text: string },
  { cancel: { reason: string }; 'add-context': { context: string } }
>;

type StreamSocket = ReturnType<typeof buildStream>['socket'];

/** Trigger a stream and complete the server's __streamOk__ handshake. */
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

describe('triggering and iterating', () => {
  it('resolves on __streamOk__ and yields chunks until __streamEnd__', async () => {
    const { socket, ws } = buildStream();
    const { handle, sid } = await start(socket, ws);
    ws.emit({ event: 'ask-ai', payload: { text: 'a' }, metadata: { stream: { id: sid, seq: 1 } } });
    ws.emit({ event: 'ask-ai', payload: { text: 'b' }, metadata: { stream: { id: sid, seq: 2 } } });
    ws.emit({ event: '__streamEnd__', payload: {}, metadata: { stream: { id: sid } } });

    expect(await collect(handle)).toEqual([{ text: 'a' }, { text: 'b' }]);
  });

  it('drops chunks already delivered (per-seq dedup)', async () => {
    const { socket, ws } = buildStream();
    const { handle, sid } = await start(socket, ws);
    ws.emit({ event: 'ask-ai', payload: { text: 'a' }, metadata: { stream: { id: sid, seq: 1 } } });
    ws.emit({ event: 'ask-ai', payload: { text: 'a' }, metadata: { stream: { id: sid, seq: 1 } } });
    ws.emit({ event: 'ask-ai', payload: { text: 'b' }, metadata: { stream: { id: sid, seq: 2 } } });

    ws.emit({ event: '__streamEnd__', payload: {}, metadata: { stream: { id: sid } } });
    expect(await collect(handle)).toEqual([{ text: 'a' }, { text: 'b' }]);
  });

  it('throws a typed error when the server sends __error__', async () => {
    const { socket, ws } = buildStream();
    const { handle, sid } = await start(socket, ws);
    ws.emit({
      event: '__error__',
      payload: { code: 'quota-exceeded', detail: { limit: 5 } },
      metadata: { stream: { id: sid } },
    });
    await expect(collect(handle)).rejects.toMatchObject({
      code: 'quota-exceeded',
      detail: { limit: 5 },
    });
  });

  it('rejects the stream() promise on an error that arrives before __streamOk__', async () => {
    const { socket, ws } = buildStream();
    const promise = socket.stream('ask-ai', { prompt: 'hi' });
    const sid = ws.sentFrames().at(-1).metadata.stream?.id as string;
    ws.emit({
      event: '__error__',
      payload: { code: 'stream-already-active' },
      metadata: { stream: { id: sid } },
    });
    await expect(promise).rejects.toMatchObject({ code: 'stream-already-active' });
  });

  it('throws Disconnected when the socket disconnects mid-stream', async () => {
    const { socket, ws } = buildStream();
    const { handle } = await start(socket, ws);
    socket.disconnect();
    await expect(collect(handle)).rejects.toMatchObject({ code: 'disconnected' });
  });

  it('throws Timeout when no chunk arrives in time', async () => {
    vi.useFakeTimers();
    try {
      const { socket, ws } = buildStream(stream({ timeout: 1000 }));
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
    const { socket, ws } = buildStream();
    const { handle, sid } = await start(socket, ws);
    const pending = handle.nudge('add-context', { context: 'ocean' });
    const frame = ws.sentFrames().at(-1);
    expect(frame).toEqual({
      event: 'add-context',
      payload: { context: 'ocean' },
      metadata: { stream: { id: sid, nudgeId: expect.any(String) } },
    });

    ws.emit({
      event: '__nudgeOk__',
      payload: null,
      metadata: { stream: { id: sid, nudgeId: frame.metadata.stream?.nudgeId } },
    });
    await expect(pending).resolves.toBeUndefined();
    ws.emit({ event: '__streamEnd__', payload: {}, metadata: { stream: { id: sid } } });
    expect(handle.active).toBe(false);
  });

  it('rejects the nudge() Promise on a non-terminal error without ending the stream', async () => {
    const { socket, ws } = buildStream();
    const { handle, sid } = await start(socket, ws);
    const pending = handle.nudge('add-context', { context: 'ocean' });
    const streamNudgeId = ws.sentFrames().at(-1).metadata.stream?.nudgeId as string;
    ws.emit({
      event: '__error__',
      payload: { code: 'validation-failed' },
      metadata: { stream: { id: sid, nudgeId: streamNudgeId, terminated: false } },
    });

    await expect(pending).rejects.toMatchObject({ code: 'validation-failed' });
    ws.emit({ event: 'ask-ai', payload: { text: 'a' }, metadata: { stream: { id: sid, seq: 1 } } });
    ws.emit({ event: '__streamEnd__', payload: {}, metadata: { stream: { id: sid } } });
    expect(await collect(handle)).toEqual([{ text: 'a' }]);
  });

  it('settles a pending nudge when the stream is cancelled', async () => {
    const { socket, ws } = buildStream(stream({ nudgeTimeout: 0 }));
    const { handle } = await start(socket, ws);
    const pending = handle.nudge('add-context', { context: 'ocean' });

    handle.cancel();

    await expect(pending).resolves.toBeUndefined();
  });

  it('settles a pending nudge when the stream ends', async () => {
    const { socket, ws } = buildStream(stream({ nudgeTimeout: 0 }));
    const { handle, sid } = await start(socket, ws);
    const pending = handle.nudge('add-context', { context: 'ocean' });

    ws.emit({ event: '__streamEnd__', payload: {}, metadata: { stream: { id: sid } } });

    await expect(pending).resolves.toBeUndefined();
  });

  it('rejects a pending nudge with the error that ends the stream', async () => {
    const { socket, ws } = buildStream(stream({ nudgeTimeout: 0 }));
    const { handle, sid } = await start(socket, ws);
    const pending = handle.nudge('add-context', { context: 'ocean' });
    const collected = collect(handle).catch(() => {});

    ws.emit({
      event: '__error__',
      payload: { code: 'internal-error' },
      metadata: { stream: { id: sid } },
    });

    await expect(pending).rejects.toMatchObject({ code: 'internal-error' });
    await collected;
  });

  it('cancel() sends __streamCancel__ and ends the loop without throwing', async () => {
    const { socket, ws } = buildStream();
    const { handle, sid } = await start(socket, ws);
    handle.cancel();
    expect(ws.sentFrames().at(-1)).toEqual({
      event: '__streamCancel__',
      payload: null,
      metadata: { stream: { id: sid } },
    });
    expect(await collect(handle)).toEqual([]);
  });

  it('breaking out of the loop cancels the stream', async () => {
    const { socket, ws } = buildStream();
    const { handle, sid } = await start(socket, ws);
    ws.emit({ event: 'ask-ai', payload: { text: 'a' }, metadata: { stream: { id: sid, seq: 1 } } });
    for await (const _chunk of handle) {
      void _chunk;
      break;
    }

    expect(ws.sentFrames().at(-1).event).toBe('__streamCancel__');
  });
});

describe('onStream (broadcast)', () => {
  it('fires onChunk then onEnd', () => {
    const { socket, ws } = buildStream();
    const onChunk = vi.fn();
    const onEnd = vi.fn();
    socket.onStream('ask-ai', { onChunk, onEnd });
    ws.emit({
      event: 'ask-ai',
      payload: { text: 'a' },
      metadata: { stream: { id: 'bs1', seq: 1 } },
    });

    expect(onChunk).toHaveBeenCalledWith({ text: 'a' }, 'bs1');
    ws.emit({ event: '__streamEnd__', payload: {}, metadata: { stream: { id: 'bs1', seq: 5 } } });
    expect(onEnd).toHaveBeenCalledWith('bs1', 5);
  });

  it('fires onError with StreamAborted interrupted when a viewed stream is cut off', () => {
    const { socket, ws } = buildStream();
    const onEnd = vi.fn();
    const onError = vi.fn();
    socket.onStream('ask-ai', { onChunk: () => {}, onEnd, onError });
    ws.emit({
      event: 'ask-ai',
      payload: { text: 'a' },
      metadata: { stream: { id: 'bs3', seq: 1 } },
    });

    ws.emit({
      event: '__error__',
      payload: { code: 'stream-aborted', detail: { reason: 'interrupted' } },
      metadata: { stream: { id: 'bs3', event: 'ask-ai', terminated: true } },
    });

    expect(onEnd).not.toHaveBeenCalled();
    const [error, streamId] = onError.mock.calls[0]!;
    expect(streamId).toBe('bs3');
    expect(StreamAborted.matches(error) && error.detail.reason === 'interrupted').toBe(true);
  });

  it('fires onError when the broadcast stream errors', () => {
    const { socket, ws } = buildStream();
    const onError = vi.fn();
    socket.onStream('ask-ai', { onChunk: () => {}, onError });
    ws.emit({
      event: 'ask-ai',
      payload: { text: 'a' },
      metadata: { stream: { id: 'bs2', seq: 1 } },
    });
    ws.emit({
      event: '__error__',
      payload: { code: 'internal-error' },
      metadata: { stream: { id: 'bs2' } },
    });

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'internal-error' }),
      'bs2',
    );
  });
});

describe('durable continue', () => {
  it('sends a lazy continue only after the socket opens', () => {
    const socket = client<C>()(connect('wss://test', { lazy: true }), stream());

    socket.continueStream('ask-ai', 'feed-lazy', { lastKnownSeq: 4 });
    const ws = MockWebSocket.last();
    expect(ws.sentFrames()).toEqual([]);

    ws.open();
    expect(ws.sentFrames()).toContainEqual({
      event: '__continueStream__',
      payload: { lastKnownSeq: 4 },
      metadata: { stream: { id: 'feed-lazy' } },
    });
    socket.disconnect();
  });

  it('sends __continueStream__ with lastKnownSeq after a reconnect', async () => {
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
        metadata: { stream: { id: sid, seq: 7 } },
      });
      first.serverClose(1006, 'drop');
      vi.advanceTimersByTime(1500);
      const second = MockWebSocket.last();
      second.open();

      expect(second.sentFrames()).toContainEqual({
        event: '__continueStream__',
        payload: { lastKnownSeq: 7 },
        metadata: { stream: { id: sid } },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('continueStream replays chunks into the returned handle and ends on __streamEnd__', async () => {
    const { socket, ws } = buildStream();
    const handle = socket.continueStream('ask-ai', 'feed-1', { lastKnownSeq: 0 });
    expect(ws.sentFrames().at(-1)).toEqual({
      event: '__continueStream__',
      payload: { lastKnownSeq: 0 },
      metadata: { stream: { id: 'feed-1' } },
    });
    ws.emit({
      event: 'ask-ai',
      payload: { text: 'a' },
      metadata: { stream: { id: 'feed-1', seq: 1 } },
    });
    ws.emit({
      event: 'ask-ai',
      payload: { text: 'b' },
      metadata: { stream: { id: 'feed-1', seq: 2 } },
    });

    ws.emit({ event: '__streamEnd__', payload: {}, metadata: { stream: { id: 'feed-1' } } });
    expect(await collect(handle)).toEqual([{ text: 'a' }, { text: 'b' }]);
  });

  it('continueStream replays chunks, then throws StreamAborted interrupted for a cut-off stream', async () => {
    const { socket, ws } = buildStream();
    const handle = socket.continueStream('ask-ai', 'reply-1', { lastKnownSeq: 0 });
    ws.emit({
      event: 'ask-ai',
      payload: { text: 'a' },
      metadata: { stream: { id: 'reply-1', seq: 1 } },
    });
    ws.emit({
      event: 'ask-ai',
      payload: { text: 'b' },
      metadata: { stream: { id: 'reply-1', seq: 2 } },
    });
    ws.emit({
      event: '__error__',
      payload: { code: 'stream-aborted', detail: { reason: 'interrupted' } },
      metadata: { stream: { id: 'reply-1', event: 'ask-ai', terminated: true } },
    });

    const received: { text: string }[] = [];
    let caught: unknown;
    try {
      for await (const chunk of handle) received.push(chunk);
    } catch (error) {
      caught = error;
    }

    expect(received).toEqual([{ text: 'a' }, { text: 'b' }]);
    expect(StreamAborted.matches(caught) && caught.detail.reason === 'interrupted').toBe(true);
  });

  it('scoped continueStream carries the channel markers', async () => {
    const { socket, ws } = buildStreamChannels();
    const room = socket.channel('rooms', 'r1');
    const sub = room.subscribe();
    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      metadata: { exchange: { source: 'client' }, channel: { name: 'r1', family: 'rooms' } },
    });
    await sub;

    const handle = room.continueStream('ask-ai', 'feed-2', { lastKnownSeq: 0 });
    expect(ws.sentFrames().at(-1)).toEqual({
      event: '__continueStream__',
      payload: { lastKnownSeq: 0 },
      metadata: { channel: { name: 'r1', family: 'rooms' }, stream: { id: 'feed-2' } },
    });
    ws.emit({
      event: 'ask-ai',
      payload: { text: 'x' },
      metadata: { channel: { name: 'r1', family: 'rooms' }, stream: { id: 'feed-2', seq: 1 } },
    });
    ws.emit({ event: '__streamEnd__', payload: {}, metadata: { stream: { id: 'feed-2' } } });
    expect(await collect(handle)).toEqual([{ text: 'x' }]);
  });
});

describe('scoped streams', () => {
  it('tags a channel stream trigger with the channel markers', async () => {
    const { socket, ws } = buildStreamChannels();
    const room = socket.channel('rooms', 'r1');
    const sub = room.subscribe();
    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      metadata: { exchange: { source: 'client' }, channel: { name: 'r1', family: 'rooms' } },
    });
    await sub;

    const pending = room.stream('ask-ai', { prompt: 'hi' });
    const frame = ws.sentFrames().at(-1);
    expect(frame.event).toBe('ask-ai');
    expect(frame.metadata).toMatchObject({ channel: { name: 'r1', family: 'rooms' } });
    expect(typeof frame.metadata.stream?.id).toBe('string');

    socket.disconnect();
    await expect(pending).rejects.toMatchObject({ code: 'disconnected' });
  });
});

describe('lazy consumer leak on failed send', () => {
  it('lazyConsumers returns to 0 when the trigger send fails, and stream() rejects', async () => {
    const socket = client<C>()(connect('wss://test', { lazy: true, idleTimeout: 0 }), stream());
    socket.connect();
    const ws = MockWebSocket.last();
    ws.open();

    const original = ws.send.bind(ws);
    let calls = 0;
    ws.send = (data: unknown) => {
      calls++;
      if (calls === 1) throw new Error('network error');

      original(data);
    };

    // socket.stream() must never throw synchronously: it returns a rejected Promise
    // and rolls back the lazy hold it acquired, so _lazyConsumers stays at 0.
    let promise: Promise<unknown>;
    expect(() => {
      promise = socket.stream('ask-ai', { prompt: 'hi' });
    }).not.toThrow();
    await expect(promise!).rejects.toThrow('network error');

    expect((socket as unknown as LiveThingSocket)._lazyConsumers).toBe(0);
  });
});

describe('stream() never throws synchronously on a bad payload', () => {
  it('returns a rejected Promise (not a throw) when the payload will not serialize', async () => {
    const { socket } = buildStream();
    const before = (socket as unknown as LiveThingSocket)._lazyConsumers;
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    let promise: Promise<unknown>;
    expect(() => {
      promise = socket.stream('ask-ai', circular as unknown as { prompt: string });
    }).not.toThrow();
    await expect(promise!).rejects.toBeInstanceOf(TypeError);

    expect((socket as unknown as LiveThingSocket)._lazyConsumers).toBe(before);
  });
});

describe('stream trigger and nudge reject reserved event names', () => {
  it('rejects a reserved trigger event name locally with validation-failed and no send', async () => {
    const { socket, ws } = buildStream();
    const trigger = socket.stream as (e: string, p: unknown) => Promise<unknown>;
    for (const name of ['__subscribe__', '__custom', '__error__']) {
      await expect(trigger(name, { prompt: 'hi' })).rejects.toMatchObject({
        code: 'validation-failed',
      });
    }

    expect(ws.sentFrames().some((f) => f.event.startsWith('__'))).toBe(false);
  });

  it('rejects a reserved nudge event name locally with validation-failed and no send', async () => {
    const { socket, ws } = buildStream();
    const { handle } = await start(socket, ws, { streamDurability: 'persistent' });
    const before = ws.sentFrames().length;
    await expect(
      (handle.nudge as (e: string, p: unknown) => Promise<void>)('__custom', {}),
    ).rejects.toMatchObject({ code: 'validation-failed' });
    expect(ws.sentFrames().length).toBe(before);

    handle.cancel();
  });

  it('nudge returns a rejected Promise when its payload will not serialize', async () => {
    const { socket, ws } = buildStream();
    const { handle } = await start(socket, ws, { streamDurability: 'persistent' });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(
      (handle.nudge as (e: string, p: unknown) => Promise<void>)('add-context', circular),
    ).rejects.toBeInstanceOf(TypeError);

    handle.cancel();
  });
});

describe('stream wire-limit validation', () => {
  it('rejects an over-limit custom streamId without acquiring a lazy hold', async () => {
    const { socket } = buildStream();
    const before = (socket as unknown as LiveThingSocket)._lazyConsumers;
    const tooLong = 'x'.repeat(WIRE_LIMITS.streamId + 1);

    await expect(
      socket.stream('ask-ai', { prompt: 'hi' }, { streamId: tooLong }),
    ).rejects.toMatchObject({ code: 'validation-failed' });

    expect((socket as unknown as LiveThingSocket)._lazyConsumers).toBe(before);
  });

  it('accepts a custom streamId exactly at the limit', async () => {
    const { socket, ws } = buildStream();
    const atLimit = 'x'.repeat(WIRE_LIMITS.streamId);
    const pending = socket.stream('ask-ai', { prompt: 'hi' }, { streamId: atLimit });
    expect(ws.sentFrames().at(-1).metadata.stream?.id).toBe(atLimit);
    socket.disconnect();

    await expect(pending).rejects.toMatchObject({ code: 'disconnected' });
  });
});

describe('stream id uniqueness across clients', () => {
  it('two fresh sockets do not generate the same streamId', async () => {
    const a = buildStream();
    const b = buildStream();
    const aPending = a.socket.stream('ask-ai', { prompt: 'hi' });
    const bPending = b.socket.stream('ask-ai', { prompt: 'hi' });
    // Both counters start at 1; only the per-socket random scope keeps them apart,
    // so a shared server stream map can't have one client clobber the other.
    expect(a.ws.sentFrames().at(-1).metadata.stream?.id).not.toBe(
      b.ws.sentFrames().at(-1).metadata.stream?.id,
    );
    a.socket.disconnect();
    b.socket.disconnect();
    await expect(aPending).rejects.toMatchObject({ code: 'disconnected' });
    await expect(bPending).rejects.toMatchObject({ code: 'disconnected' });
  });
});

describe('one reconnect decision per close', () => {
  it('calls a stateful shouldReconnect callback once per close even with an active durable stream', async () => {
    let calls = 0;
    function shouldReconnect(): boolean {
      calls++;
      return calls === 1;
    }

    const socket = client<C>()(connect('wss://test'), stream(), reconnection({ shouldReconnect }));
    socket.connect();
    const ws = MockWebSocket.last();
    ws.open();
    const promise = socket.stream('ask-ai', { prompt: 'hi' });

    const sid = ws.sentFrames().at(-1).metadata.stream?.id as string;
    ws.emit({
      event: '__streamOk__',
      payload: {},
      metadata: { stream: { id: sid, durability: 'persistent' } },
    });
    const handle = await promise;

    ws.serverClose(1006);

    expect(calls).toBe(1);
    expect(socket.state.get()).toBe('reconnecting');
    expect(handle.active).toBe(true);
    socket.disconnect();
  });
});

describe('stream control frames while not open', () => {
  it('nudge rejects with Disconnected immediately while reconnecting, not after the timeout', async () => {
    const socket = client<C>()(connect('wss://test'), stream(), reconnection());
    socket.connect();
    const ws = MockWebSocket.last();
    ws.open();
    const promise = socket.stream('ask-ai', { prompt: 'hi' });

    const sid = ws.sentFrames().at(-1).metadata.stream?.id as string;
    ws.emit({
      event: '__streamOk__',
      payload: {},
      metadata: { stream: { id: sid, durability: 'persistent' } },
    });
    const handle = await promise;

    ws.serverClose(1006);
    expect(socket.state.get()).toBe('reconnecting');
    expect(handle.active).toBe(true);

    await expect(handle.nudge('add-context', { context: 'x' })).rejects.toMatchObject({
      code: 'disconnected',
    });
    socket.disconnect();
  });

  it('continueStream on a closed non-lazy socket settles the handle with Disconnected', async () => {
    const socket = client<C>()(connect('wss://test'), stream());
    // Never connected: closed, non-lazy. The continue frame can't go out and no
    // reconnect is coming, so the handle must settle rather than hang.
    const handle = socket.continueStream('ask-ai', 'feed-x', { lastKnownSeq: 0 });
    await expect(collect(handle)).rejects.toMatchObject({ code: 'disconnected' });
  });
});

describe('stream wire-id and nudge validation', () => {
  it('nudge with an unserializable payload rejects', async () => {
    const { socket, ws } = buildStream();
    const { handle } = await start(socket, ws);
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await expect(
      handle.nudge('add-context', circular as unknown as { context: string }),
    ).rejects.toBeInstanceOf(TypeError);
    handle.cancel();
  });

  it('continueStream with an empty id settles the handle with validation-failed', async () => {
    const { socket } = buildStream();
    const handle = socket.continueStream('ask-ai', '', { lastKnownSeq: 0 });
    await expect(collect(handle)).rejects.toMatchObject({ code: 'validation-failed' });
  });

  it('rejects an over-limit event name on trigger before any send', async () => {
    const { socket, ws } = buildStream();
    const longEvent = 'e'.repeat(WIRE_LIMITS.event + 1);
    const before = ws.sentFrames().length;
    await expect(
      socket.stream(longEvent as unknown as 'ask-ai', { prompt: 'hi' }),
    ).rejects.toMatchObject({ code: 'validation-failed' });
    expect(ws.sentFrames().length).toBe(before);
  });
});
