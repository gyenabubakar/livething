// Uploads on the client. The names and shapes are Huddle's.
import {
  LiveThingConfigError,
  LiveThingError,
  splitBinaryFrame,
  UploadAborted,
} from '@livething/core';
import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { Disconnected } from '~/errors.ts';
import { plugin } from '~/plugins/plugins.ts';
import { binary } from '~/primitives/binary/index.ts';
import { buffering } from '~/primitives/buffering/index.ts';
import { channels } from '~/primitives/channels/index.ts';
import { uploads } from '~/primitives/uploads/index.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Primitive } from '~/primitives/types.ts';

interface C {
  binary: {
    uploads: {
      'upload-attachment': {
        payload: { attachmentId: string };
        response: { size: number };
      };
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

function typed() {
  return client<C>()(connect('wss://test'), binary(), uploads());
}

function connected(...extras: Primitive[]) {
  const socket = client<C>()(
    connect('wss://test') as never,
    binary(),
    uploads(),
    ...(extras as []),
  ) as unknown as ReturnType<typeof typed>;
  socket.connect();
  const ws = MockWebSocket.last();
  ws.open();

  return { socket, ws };
}

interface Sent {
  event: string;
  payload: unknown;
  metadata: any;
  bytes?: number[];
}

function sent(ws: MockWebSocket): Sent[] {
  return ws.sent.map((data) => {
    if (typeof data === 'string') {
      const [event, payload, metadata] = JSON.parse(data);
      return { event, payload, metadata };
    }

    const split = splitBinaryFrame(data as Uint8Array);
    if (split.kind !== 'frame') throw new Error('not a binary frame');

    const [event, payload, metadata] = JSON.parse(split.envelope);

    return { event, payload, metadata, bytes: [...split.bytes] };
  });
}

function ack(ws: MockWebSocket, id: string, payload: Record<string, number>): void {
  ws.emit({ event: '__uploadAck__', payload, metadata: { upload: { id } } });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

const deck = { attachmentId: 'att_deck' };
const file = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

describe('socket.binary.upload', () => {
  it('sends nothing until start(), then the start frame with the size', async () => {
    const { socket, ws } = connected();
    const upload = socket.binary.upload('upload-attachment', file, {
      input: deck,
      uploadId: 'up-1',
    });
    expect(upload.id).toBe('up-1');
    await settle();
    expect(ws.sent).toHaveLength(0);

    void upload.start();
    await settle();
    expect(sent(ws)).toEqual([
      {
        event: 'upload-attachment',
        payload: deck,
        metadata: { upload: { id: 'up-1', size: 10 } },
        bytes: [],
      },
    ]);
  });

  it('sends pieces inside the window, waits for acks, ends, and resolves with the reply', async () => {
    const { socket, ws } = connected();
    const upload = socket.binary.upload('upload-attachment', file, {
      input: deck,
      uploadId: 'up-1',
    });
    const progress: number[] = [];
    upload.onProgress((bytes) => progress.push(bytes));
    const done = upload.start();

    await settle();

    ack(ws, 'up-1', { receivedThrough: 0, savedThrough: 0, pieceBytes: 4, windowBytes: 8 });
    await settle();
    // Two pieces fill the 8-byte window.
    expect(sent(ws).slice(1)).toEqual([
      {
        event: 'upload-attachment',
        payload: null,
        metadata: { upload: { id: 'up-1', seq: 1 } },
        bytes: [1, 2, 3, 4],
      },
      {
        event: 'upload-attachment',
        payload: null,
        metadata: { upload: { id: 'up-1', seq: 2 } },
        bytes: [5, 6, 7, 8],
      },
    ]);

    ack(ws, 'up-1', { receivedThrough: 4, savedThrough: 4 });
    await settle();
    expect(sent(ws).slice(3)).toEqual([
      {
        event: 'upload-attachment',
        payload: null,
        metadata: { upload: { id: 'up-1', seq: 3 } },
        bytes: [9, 10],
      },
      { event: '__uploadEnd__', payload: { totalBytes: 10 }, metadata: { upload: { id: 'up-1' } } },
    ]);

    ws.emit({
      event: '__uploadDone__',
      payload: { info: { size: 10 } },
      metadata: { upload: { id: 'up-1' } },
    });
    await expect(done).resolves.toEqual({ info: { size: 10 } });
    expect(progress).toEqual([0, 4]);

    // A finished upload gives the same result, and sends nothing more.
    const count = ws.sent.length;
    await expect(upload.start()).resolves.toEqual({ info: { size: 10 } });
    expect(ws.sent).toHaveLength(count);
  });

  it('uploads an empty file: no pieces, then the end with totalBytes 0', async () => {
    const { socket, ws } = connected();
    const upload = socket.binary.upload('upload-attachment', new Uint8Array(0), {
      input: deck,
      uploadId: 'up-1',
    });
    const done = upload.start();
    await settle();

    ack(ws, 'up-1', { receivedThrough: 0, savedThrough: 0, pieceBytes: 4, windowBytes: 8 });
    await settle();
    expect(sent(ws)).toEqual([
      {
        event: 'upload-attachment',
        payload: deck,
        metadata: { upload: { id: 'up-1', size: 0 } },
        bytes: [],
      },
      { event: '__uploadEnd__', payload: { totalBytes: 0 }, metadata: { upload: { id: 'up-1' } } },
    ]);

    ws.emit({
      event: '__uploadDone__',
      payload: { info: { size: 0 } },
      metadata: { upload: { id: 'up-1' } },
    });
    await expect(done).resolves.toEqual({ info: { size: 0 } });
  });

  it('returns the same promise from a second start() while one runs', () => {
    const { socket } = connected();
    const upload = socket.binary.upload('upload-attachment', file, { input: deck });
    expect(upload.start()).toBe(upload.start());
  });

  it('rejects with Disconnected on a drop, then resumes from the saved offset with seq from 1', async () => {
    const { socket, ws } = connected();
    const upload = socket.binary.upload('upload-attachment', file, {
      input: deck,
      uploadId: 'up-1',
    });
    const first = upload.start();
    await settle();
    ack(ws, 'up-1', { receivedThrough: 0, savedThrough: 0, pieceBytes: 4, windowBytes: 4 });

    await settle();
    ws.serverClose(1006);
    await expect(first).rejects.toMatchObject({ code: Disconnected().code });

    socket.connect();
    const ws2 = MockWebSocket.last();
    ws2.open();
    const second = upload.start();
    await settle();

    ack(ws2, 'up-1', { receivedThrough: 4, savedThrough: 4, pieceBytes: 4, windowBytes: 8 });
    await settle();
    expect(sent(ws2).slice(1, 3)).toEqual([
      {
        event: 'upload-attachment',
        payload: null,
        metadata: { upload: { id: 'up-1', seq: 1 } },
        bytes: [5, 6, 7, 8],
      },
      {
        event: 'upload-attachment',
        payload: null,
        metadata: { upload: { id: 'up-1', seq: 2 } },
        bytes: [9, 10],
      },
    ]);

    ws2.emit({
      event: '__uploadDone__',
      payload: { info: { size: 10 } },
      metadata: { upload: { id: 'up-1' } },
    });
    await expect(second).resolves.toEqual({ info: { size: 10 } });
  });

  it('resolves at once when the server answers a start with the stored reply', async () => {
    const { socket, ws } = connected();
    const upload = socket.binary.upload('upload-attachment', file, {
      input: deck,
      uploadId: 'up-1',
    });
    const done = upload.start();
    await settle();
    ws.emit({
      event: '__uploadDone__',
      payload: { info: { size: 10 } },
      metadata: { upload: { id: 'up-1' } },
    });

    await expect(done).resolves.toEqual({ info: { size: 10 } });
    expect(sent(ws)).toHaveLength(1);
  });

  it('cancel() rejects the running start, tells the server, and refuses every later start', async () => {
    const { socket, ws } = connected();
    const upload = socket.binary.upload('upload-attachment', file, {
      input: deck,
      uploadId: 'up-1',
    });
    const running = upload.start();
    await settle();

    upload.cancel();
    await expect(running).rejects.toMatchObject({
      code: 'upload-aborted',
      detail: { reason: 'cancelled' },
    });
    expect(sent(ws).at(-1)).toEqual({
      event: '__uploadCancel__',
      payload: null,
      metadata: { upload: { id: 'up-1' } },
    });
    await expect(upload.start()).rejects.toMatchObject({ detail: { reason: 'cancelled' } });
  });

  describe('with an AsyncIterable that never gives its next chunk', () => {
    function stuckSource() {
      const returned = vi.fn(() => new Promise<IteratorResult<Uint8Array>>(() => {}));
      const source: AsyncIterable<Uint8Array> = {
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise<IteratorResult<Uint8Array>>(() => {}),
          return: returned,
        }),
      };

      return { source, returned };
    }

    async function outcome(promise: Promise<unknown>): Promise<unknown> {
      return Promise.race([
        promise.then(
          () => 'resolved',
          (error: unknown) => error,
        ),
        settle().then(() => 'still waiting'),
      ]);
    }

    it('cancel() rejects the start at once, closes the source, and tells the server once', async () => {
      const { socket, ws } = connected();
      const { source, returned } = stuckSource();
      const upload = socket.binary.upload('upload-attachment', source, {
        input: deck,
        uploadId: 'up-1',
      });
      const running = upload.start();
      await settle();

      ack(ws, 'up-1', { receivedThrough: 0, savedThrough: 0, pieceBytes: 4, windowBytes: 8 });
      await settle();
      upload.cancel();

      expect(await outcome(running)).toMatchObject({
        code: 'upload-aborted',
        detail: { reason: 'cancelled' },
      });
      expect(returned).toHaveBeenCalledOnce();
      expect(sent(ws).filter((frame) => frame.event === '__uploadCancel__')).toHaveLength(1);
    });

    it('a drop rejects the start with Disconnected and closes the source', async () => {
      const { socket, ws } = connected();
      const { source, returned } = stuckSource();
      const upload = socket.binary.upload('upload-attachment', source, {
        input: deck,
        uploadId: 'up-1',
      });
      const running = upload.start();
      await settle();

      ack(ws, 'up-1', { receivedThrough: 0, savedThrough: 0, pieceBytes: 4, windowBytes: 8 });
      await settle();
      ws.serverClose(1006);

      expect(await outcome(running)).toMatchObject({ code: Disconnected().code });
      expect(returned).toHaveBeenCalledOnce();
    });

    it('cancel() leaves no unhandled rejection when the source fails to close', async () => {
      const unhandled: unknown[] = [];
      function onUnhandled(reason: unknown): void {
        unhandled.push(reason);
      }

      process.on('unhandledRejection', onUnhandled);
      try {
        const { socket, ws } = connected();
        const source: AsyncIterable<Uint8Array> = {
          [Symbol.asyncIterator]: () => ({
            next: () => new Promise<IteratorResult<Uint8Array>>(() => {}),
            return: () => Promise.reject(new Error('the file was already closed')),
          }),
        };

        const upload = socket.binary.upload('upload-attachment', source, {
          input: deck,
          uploadId: 'up-1',
        });
        const running = upload.start();
        await settle();

        ack(ws, 'up-1', { receivedThrough: 0, savedThrough: 0, pieceBytes: 4, windowBytes: 8 });
        await settle();

        upload.cancel();

        expect(await outcome(running)).toMatchObject({ detail: { reason: 'cancelled' } });
        await settle();
        expect(unhandled).toEqual([]);
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    });
  });

  it('does not close an AsyncIterable whose next() throws, as for await does', async () => {
    const { socket, ws } = connected();
    const returned = vi.fn(async () => ({ done: true as const, value: undefined }));
    const source: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          throw new Error('the disk is gone');
        },
        return: returned,
      }),
    };

    const upload = socket.binary.upload('upload-attachment', source, {
      input: deck,
      uploadId: 'up-1',
    });
    const running = upload.start();

    await settle();

    ack(ws, 'up-1', { receivedThrough: 0, savedThrough: 0, pieceBytes: 4, windowBytes: 8 });

    await expect(running).rejects.toThrow('the disk is gone');
    expect(returned).not.toHaveBeenCalled();
  });

  it("rejects with UploadAborted 'bad-state' when the server could not read back the saved state", async () => {
    const { socket, ws } = connected();
    const upload = socket.binary.upload('upload-attachment', file, {
      input: deck,
      uploadId: 'up-1',
    });
    const running = upload.start();
    await settle();
    ws.emit({
      event: '__error__',
      payload: { code: 'upload-aborted', detail: { reason: 'bad-state' } },
      metadata: { upload: { id: 'up-1' } },
    });

    const error = await running.catch((caught: unknown) => caught);
    expect(UploadAborted.matches(error) && error.detail.reason).toBe('bad-state');
  });

  it('rejects with the server error, and a later start() is a new start', async () => {
    const { socket, ws } = connected();
    const upload = socket.binary.upload('upload-attachment', file, {
      input: deck,
      uploadId: 'up-1',
    });
    const running = upload.start();
    await settle();
    ws.emit({
      event: '__error__',
      payload: { code: 'upload-aborted', detail: { reason: 'too-large' } },
      metadata: { upload: { id: 'up-1' } },
    });

    const error = await running.catch((caught: unknown) => caught);
    expect(UploadAborted.matches(error)).toBe(true);
    expect(error).toBeInstanceOf(LiveThingError);

    void upload.start();
    await settle();
    expect(sent(ws).filter((frame) => frame.event === 'upload-attachment')).toHaveLength(2);
  });

  it('reads an AsyncIterable once: cuts it into pieces, and cannot resume after a drop', async () => {
    const { socket, ws } = connected();
    async function* chunks() {
      yield new Uint8Array([1, 2, 3]);
      yield new Uint8Array([4, 5, 6, 7, 8]);
    }

    const upload = socket.binary.upload('upload-attachment', chunks(), {
      input: deck,
      uploadId: 'up-1',
    });
    const first = upload.start();
    await settle();
    expect(sent(ws)[0]!.metadata).toEqual({ upload: { id: 'up-1' } });

    // The server already saved 2 bytes, so the client skips them.
    ack(ws, 'up-1', { receivedThrough: 2, savedThrough: 2, pieceBytes: 4, windowBytes: 16 });
    await settle();
    expect(
      sent(ws)
        .slice(1)
        .map((frame) => frame.bytes ?? frame.payload),
    ).toEqual([[3, 4, 5, 6], [7, 8], { totalBytes: 8 }]);

    ws.serverClose(1006);
    await expect(first).rejects.toMatchObject({ code: 'disconnected' });
    await expect(upload.start()).rejects.toMatchObject({ detail: { reason: 'not-resumable' } });
  });

  it('starts an AsyncIterable again when the connection dropped before anything read it', async () => {
    const { socket, ws } = connected();
    let reads = 0;
    async function* chunks() {
      reads += 1;
      yield new Uint8Array([1, 2, 3]);
    }

    const upload = socket.binary.upload('upload-attachment', chunks(), {
      input: deck,
      uploadId: 'up-1',
    });
    const first = upload.start();
    await settle();
    ws.serverClose(1006);
    await expect(first).rejects.toMatchObject({ code: 'disconnected' });

    expect(reads).toBe(0);

    socket.connect();
    const ws2 = MockWebSocket.last();
    ws2.open();
    const second = upload.start();
    await settle();

    ack(ws2, 'up-1', { receivedThrough: 0, savedThrough: 0, pieceBytes: 4, windowBytes: 16 });
    await settle();
    expect(
      sent(ws2)
        .slice(1)
        .map((frame) => frame.bytes ?? frame.payload),
    ).toEqual([[1, 2, 3], { totalBytes: 3 }]);

    ws2.emit({
      event: '__uploadDone__',
      payload: { info: { size: 3 } },
      metadata: { upload: { id: 'up-1' } },
    });
    await expect(second).resolves.toEqual({ info: { size: 3 } });
  });

  it('reads a Blob in slices', async () => {
    const { socket, ws } = connected();
    const blob = new Blob([file]);
    const upload = socket.binary.upload('upload-attachment', blob, {
      input: deck,
      uploadId: 'up-1',
    });
    void upload.start();
    await settle();

    ack(ws, 'up-1', { receivedThrough: 0, savedThrough: 0, pieceBytes: 6, windowBytes: 12 });
    await settle();
    expect(
      sent(ws)
        .slice(1)
        .map((frame) => frame.bytes ?? frame.payload),
    ).toEqual([[1, 2, 3, 4, 5, 6], [7, 8, 9, 10], { totalBytes: 10 }]);
  });

  it('never puts pieces in the buffering() queue', async () => {
    const { socket, ws } = connected(buffering());
    const upload = socket.binary.upload('upload-attachment', file, {
      input: deck,
      uploadId: 'up-1',
    });
    const running = upload.start();
    await settle();
    ws.serverClose(1006);

    await expect(running).rejects.toMatchObject({ code: 'disconnected' });

    socket.connect();
    const ws2 = MockWebSocket.last();
    ws2.open();
    await settle();
    expect(ws2.sent).toHaveLength(0);
  });

  it('drops a late frame for an upload that is not running, instead of reporting it', async () => {
    const { socket, ws } = connected();
    const errors: unknown[] = [];
    socket.onServerError((error) => errors.push(error));
    ws.emit({
      event: '__error__',
      payload: { code: 'upload-aborted', detail: { reason: 'taken-over' } },
      metadata: { upload: { id: 'up-old' } },
    });
    await settle();

    expect(errors).toEqual([]);
  });

  it('waits for the socket to open before it sends the start frame', async () => {
    const socket = client<C>()(
      connect('wss://test') as never,
      binary(),
      uploads(),
    ) as unknown as ReturnType<typeof typed>;
    socket.connect();
    const ws = MockWebSocket.last();
    const upload = socket.binary.upload('upload-attachment', file, {
      input: deck,
      uploadId: 'up-1',
    });
    void upload.start();

    await settle();
    expect(ws.sent).toHaveLength(0);

    ws.open();
    await settle();
    expect(sent(ws).map((frame) => frame.metadata)).toEqual([{ upload: { id: 'up-1', size: 10 } }]);
  });

  it('cancel() before start() sends the cancel, and start() then rejects', async () => {
    const { socket, ws } = connected();
    const upload = socket.binary.upload('upload-attachment', file, {
      input: deck,
      uploadId: 'up-1',
    });
    upload.cancel();
    expect(sent(ws)).toEqual([
      { event: '__uploadCancel__', payload: null, metadata: { upload: { id: 'up-1' } } },
    ]);
    await expect(upload.start()).rejects.toMatchObject({ detail: { reason: 'cancelled' } });
  });

  it('stops calling a progress listener after its unsubscribe', async () => {
    const { socket, ws } = connected();
    const upload = socket.binary.upload('upload-attachment', file, {
      input: deck,
      uploadId: 'up-1',
    });
    const progress: number[] = [];
    const stop = upload.onProgress((bytes) => progress.push(bytes));
    void upload.start();

    await settle();
    ack(ws, 'up-1', { receivedThrough: 0, savedThrough: 0, pieceBytes: 4, windowBytes: 4 });
    await settle();
    stop();

    ack(ws, 'up-1', { receivedThrough: 4, savedThrough: 4 });
    await settle();
    expect(progress).toEqual([0]);
  });

  it('resolves when the server finishes while pieces are still waiting for the window', async () => {
    const { socket, ws } = connected();
    const upload = socket.binary.upload('upload-attachment', file, {
      input: deck,
      uploadId: 'up-1',
    });
    const done = upload.start();
    await settle();
    ack(ws, 'up-1', { receivedThrough: 0, savedThrough: 0, pieceBytes: 4, windowBytes: 4 });

    await settle();
    ws.emit({
      event: '__uploadDone__',
      payload: { info: { size: 4 } },
      metadata: { upload: { id: 'up-1' } },
    });
    await expect(done).resolves.toEqual({ info: { size: 4 } });
  });

  it('starts again on its own when the server says the upload is not running there', async () => {
    const { socket, ws } = connected();
    const upload = socket.binary.upload('upload-attachment', file, {
      input: deck,
      uploadId: 'up-1',
    });
    const done = upload.start();
    await settle();
    ack(ws, 'up-1', { receivedThrough: 0, savedThrough: 0, pieceBytes: 4, windowBytes: 4 });

    await settle();
    ws.emit({
      event: '__error__',
      payload: { code: 'upload-aborted', detail: { reason: 'interrupted' } },
      metadata: { upload: { id: 'up-1' } },
    });
    await settle();

    const starts = sent(ws).filter(
      (frame) => frame.event === 'upload-attachment' && frame.payload !== null,
    );
    expect(starts).toHaveLength(2);
    expect(sent(ws).some((frame) => frame.event === '__uploadCancel__')).toBe(false);

    ws.emit({
      event: '__uploadDone__',
      payload: { info: { size: 10 } },
      metadata: { upload: { id: 'up-1' } },
    });
    await expect(done).resolves.toEqual({ info: { size: 10 } });
  });

  it('skips an interrupted that comes before this start’s first ack: an earlier start’s late answer', async () => {
    const { socket, ws } = connected();
    const upload = socket.binary.upload('upload-attachment', file, {
      input: deck,
      uploadId: 'up-1',
    });
    const done = upload.start();
    await settle();
    ws.emit({
      event: '__error__',
      payload: { code: 'upload-aborted', detail: { reason: 'interrupted' } },
      metadata: { upload: { id: 'up-1' } },
    });

    await settle();
    expect(sent(ws)).toHaveLength(1);

    ws.emit({
      event: '__uploadDone__',
      payload: { info: { size: 10 } },
      metadata: { upload: { id: 'up-1' } },
    });
    await expect(done).resolves.toEqual({ info: { size: 10 } });
  });

  it('gives up with Timeout, and tells the server, when a start gets no answer for 30 s', async () => {
    vi.useFakeTimers();
    try {
      const { socket, ws } = connected();
      const upload = socket.binary.upload('upload-attachment', file, {
        input: deck,
        uploadId: 'up-1',
      });
      const running = upload.start();
      const outcome = running.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(30_000);

      expect(await outcome).toMatchObject({ code: 'timeout' });
      expect(sent(ws).at(-1)?.event).toBe('__uploadCancel__');
    } finally {
      vi.useRealTimers();
    }
  });

  it('tells the server to discard an AsyncIterable upload that cannot resume', async () => {
    const { socket, ws } = connected();
    async function* chunks(): AsyncGenerator<Uint8Array> {
      yield new Uint8Array([1, 2]);
    }

    const upload = socket.binary.upload('upload-attachment', chunks(), {
      input: deck,
      uploadId: 'up-1',
    });
    const first = upload.start();
    await settle();
    ack(ws, 'up-1', { receivedThrough: 0, savedThrough: 0, pieceBytes: 4, windowBytes: 16 });
    await settle();

    ws.serverClose(1006);
    await expect(first).rejects.toMatchObject({ code: 'disconnected' });

    socket.connect();
    const ws2 = MockWebSocket.last();
    ws2.open();
    await expect(upload.start()).rejects.toMatchObject({ detail: { reason: 'not-resumable' } });
    // A later start() sends no second cancel.
    await expect(upload.start()).rejects.toMatchObject({ detail: { reason: 'not-resumable' } });
    expect(sent(ws2)).toEqual([
      { event: '__uploadCancel__', payload: null, metadata: { upload: { id: 'up-1' } } },
    ]);
  });

  it('cancel() ends a start that waits for the socket to open', async () => {
    const socket = client<C>()(
      connect('wss://test') as never,
      binary(),
      uploads(),
    ) as unknown as ReturnType<typeof typed>;
    socket.connect();
    const upload = socket.binary.upload('upload-attachment', file, {
      input: deck,
      uploadId: 'up-1',
    });
    const waiting = upload.start();
    await settle();

    upload.cancel();
    await expect(waiting).rejects.toMatchObject({ detail: { reason: 'cancelled' } });
  });

  it('tells the server to stop when the source fails', async () => {
    const { socket, ws } = connected();
    async function* failing(): AsyncGenerator<Uint8Array> {
      yield new Uint8Array([1, 2]);
      throw new Error('the camera stopped');
    }

    const upload = socket.binary.upload('upload-attachment', failing(), {
      input: deck,
      uploadId: 'up-1',
    });
    const running = upload.start();
    await settle();
    ack(ws, 'up-1', { receivedThrough: 0, savedThrough: 0, pieceBytes: 4, windowBytes: 8 });
    await expect(running).rejects.toThrow('the camera stopped');

    expect(sent(ws).at(-1)).toEqual({
      event: '__uploadCancel__',
      payload: null,
      metadata: { upload: { id: 'up-1' } },
    });
  });

  it('sends a cancel made while the socket was closed once it opens again', async () => {
    const { socket, ws } = connected();
    const upload = socket.binary.upload('upload-attachment', file, {
      input: deck,
      uploadId: 'up-1',
    });
    const running = upload.start();
    await settle();
    ws.serverClose(1006);

    await expect(running).rejects.toMatchObject({ code: 'disconnected' });

    upload.cancel();
    socket.connect();
    const ws2 = MockWebSocket.last();
    ws2.open();
    await settle();

    expect(sent(ws2)).toEqual([
      { event: '__uploadCancel__', payload: null, metadata: { upload: { id: 'up-1' } } },
    ]);
  });

  it('skips a late ack of an earlier start until the first ack of this one', async () => {
    const { socket, ws } = connected();
    const upload = socket.binary.upload('upload-attachment', file, {
      input: deck,
      uploadId: 'up-1',
    });
    void upload.start();
    await settle();
    ack(ws, 'up-1', { receivedThrough: 4, savedThrough: 4 });

    ack(ws, 'up-1', { receivedThrough: 8, savedThrough: 8, pieceBytes: 4, windowBytes: 8 });
    await settle();
    expect(sent(ws).slice(1, 2)).toEqual([
      {
        event: 'upload-attachment',
        payload: null,
        metadata: { upload: { id: 'up-1', seq: 1 } },
        bytes: [9, 10],
      },
    ]);
  });

  it('cuts many tiny chunks into whole pieces', async () => {
    const { socket, ws } = connected();
    async function* bytesOneByOne(): AsyncGenerator<Uint8Array> {
      for (const byte of file) yield new Uint8Array([byte]);
    }

    const upload = socket.binary.upload('upload-attachment', bytesOneByOne(), {
      input: deck,
      uploadId: 'up-1',
    });
    void upload.start();
    await settle();
    ack(ws, 'up-1', { receivedThrough: 0, savedThrough: 0, pieceBytes: 4, windowBytes: 16 });
    await settle();

    expect(
      sent(ws)
        .slice(1)
        .map((frame) => frame.bytes ?? frame.payload),
    ).toEqual([[1, 2, 3, 4], [5, 6, 7, 8], [9, 10], { totalBytes: 10 }]);
  });

  it('gives up with interrupted after 3 tries in a row that store no new bytes', async () => {
    const { socket, ws } = connected();
    const upload = socket.binary.upload('upload-attachment', file, {
      input: deck,
      uploadId: 'up-1',
    });
    const outcome = upload.start().catch((error: unknown) => error);
    for (let i = 0; i < 3; i += 1) {
      await settle();
      ack(ws, 'up-1', { receivedThrough: 0, savedThrough: 0, pieceBytes: 4, windowBytes: 4 });
      await settle();
      ws.emit({
        event: '__error__',
        payload: { code: 'upload-aborted', detail: { reason: 'interrupted' } },
        metadata: { upload: { id: 'up-1' } },
      });
    }

    expect(await outcome).toMatchObject({ detail: { reason: 'interrupted' } });
    expect(sent(ws).filter((frame) => frame.metadata?.upload?.size === 10)).toHaveLength(3);
  });

  it('starts the count of interrupted tries again when a try moves the saved offset', async () => {
    const { socket, ws } = connected();
    const upload = socket.binary.upload('upload-attachment', file, {
      input: deck,
      uploadId: 'up-1',
    });
    const outcome = upload.start().catch((error: unknown) => error);
    for (const saved of [0, 0, 4, 4, 4, 4]) {
      await settle();
      ack(ws, 'up-1', {
        receivedThrough: saved,
        savedThrough: saved,
        pieceBytes: 4,
        windowBytes: 4,
      });
      await settle();
      ws.emit({
        event: '__error__',
        payload: { code: 'upload-aborted', detail: { reason: 'interrupted' } },
        metadata: { upload: { id: 'up-1' } },
      });
    }

    expect(await outcome).toMatchObject({ detail: { reason: 'interrupted' } });
    // The third try moved the offset, so three more tries with no new bytes follow it.
    expect(sent(ws).filter((frame) => frame.metadata?.upload?.size === 10)).toHaveLength(6);
  });

  it('rejects an AsyncIterable with not-resumable when the server says interrupted', async () => {
    const { socket, ws } = connected();
    async function* chunks(): AsyncGenerator<Uint8Array> {
      yield new Uint8Array([1, 2, 3, 4]);
      yield new Uint8Array([5, 6, 7, 8]);
    }

    const upload = socket.binary.upload('upload-attachment', chunks(), {
      input: deck,
      uploadId: 'up-1',
    });
    const outcome = upload.start().catch((error: unknown) => error);
    await settle();
    ack(ws, 'up-1', { receivedThrough: 0, savedThrough: 0, pieceBytes: 4, windowBytes: 4 });
    await settle();

    ws.emit({
      event: '__error__',
      payload: { code: 'upload-aborted', detail: { reason: 'interrupted' } },
      metadata: { upload: { id: 'up-1' } },
    });

    expect(await outcome).toMatchObject({ detail: { reason: 'not-resumable' } });
    expect(sent(ws).at(-1)?.event).toBe('__uploadCancel__');
  });

  it('rejects with Disconnected at once when the socket is closed and nothing reconnects it', async () => {
    const { socket, ws } = connected();
    ws.serverClose(1006);
    await settle();
    const upload = socket.binary.upload('upload-attachment', file, {
      input: deck,
      uploadId: 'up-1',
    });

    await expect(upload.start()).rejects.toMatchObject({ code: Disconnected().code });
  });

  it('opens a lazy socket, and keeps it open while the upload runs', async () => {
    vi.useFakeTimers();
    try {
      const socket = client<C>()(
        connect('wss://test', { lazy: true }) as never,
        binary(),
        uploads(),
      ) as unknown as ReturnType<typeof typed>;
      const upload = socket.binary.upload('upload-attachment', file, {
        input: deck,
        uploadId: 'up-1',
      });
      const before = MockWebSocket.instances.length;
      void upload.start();
      expect(MockWebSocket.instances.length).toBe(before + 1);

      const ws = MockWebSocket.last();
      ws.open();
      await vi.advanceTimersByTimeAsync(0);
      ack(ws, 'up-1', { receivedThrough: 0, savedThrough: 0, pieceBytes: 4, windowBytes: 4 });
      await vi.advanceTimersByTimeAsync(10 * 60_000);

      expect(socket.state.get()).toBe('open');
    } finally {
      vi.useRealTimers();
    }
  });

  it('has no timeout once the server answered the start', async () => {
    vi.useFakeTimers();
    try {
      const { socket, ws } = connected();
      const upload = socket.binary.upload('upload-attachment', file, {
        input: deck,
        uploadId: 'up-1',
      });
      let settled = false;
      const done = upload.start().finally(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(0);

      ack(ws, 'up-1', { receivedThrough: 0, savedThrough: 0, pieceBytes: 4, windowBytes: 4 });
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(settled).toBe(false);
      expect(sent(ws).some((frame) => frame.event === '__uploadCancel__')).toBe(false);

      ws.emit({
        event: '__uploadDone__',
        payload: { info: { size: 10 } },
        metadata: { upload: { id: 'up-1' } },
      });
      await expect(done).resolves.toEqual({ info: { size: 10 } });
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancel() after the upload is done does nothing', async () => {
    const { socket, ws } = connected();
    const upload = socket.binary.upload('upload-attachment', file, {
      input: deck,
      uploadId: 'up-1',
    });
    const done = upload.start();
    await settle();
    ws.emit({
      event: '__uploadDone__',
      payload: { info: { size: 10 } },
      metadata: { upload: { id: 'up-1' } },
    });

    await done;
    const count = ws.sent.length;

    upload.cancel();
    expect(ws.sent).toHaveLength(count);
    await expect(upload.start()).resolves.toEqual({ info: { size: 10 } });
  });

  it('reports the bytes the server read, which can go back after a resume', async () => {
    const { socket, ws } = connected();
    const upload = socket.binary.upload('upload-attachment', file, {
      input: deck,
      uploadId: 'up-1',
    });
    const progress: number[] = [];
    upload.onProgress((bytes) => progress.push(bytes));
    const first = upload.start();

    await settle();
    ack(ws, 'up-1', { receivedThrough: 0, savedThrough: 0, pieceBytes: 4, windowBytes: 8 });
    await settle();
    ack(ws, 'up-1', { receivedThrough: 8, savedThrough: 4 });
    await settle();

    ws.serverClose(1006);
    await expect(first).rejects.toMatchObject({ code: 'disconnected' });

    socket.connect();
    const ws2 = MockWebSocket.last();
    ws2.open();
    void upload.start();
    await settle();

    ack(ws2, 'up-1', { receivedThrough: 4, savedThrough: 4, pieceBytes: 4, windowBytes: 8 });
    await settle();

    expect(progress).toEqual([0, 8, 4]);
  });

  it('gives an upload with no uploadId a new id of its own', () => {
    const { socket } = connected();
    const first = socket.binary.upload('upload-attachment', file, { input: deck });
    const second = socket.binary.upload('upload-attachment', file, { input: deck });

    expect(first.id).toEqual(expect.any(String));
    expect(first.id).not.toBe('');
    expect(second.id).not.toBe(first.id);
  });

  it('a start() after the upload is done returns the same result and sends nothing', async () => {
    const { socket, ws } = connected();
    const upload = socket.binary.upload('upload-attachment', file, {
      input: deck,
      uploadId: 'up-1',
    });
    const done = upload.start();
    await settle();
    ws.emit({
      event: '__uploadDone__',
      payload: { info: { size: 10 } },
      metadata: { upload: { id: 'up-1' } },
    });

    const result = await done;
    const count = ws.sent.length;

    await expect(upload.start()).resolves.toBe(result);
    await settle();
    expect(ws.sent).toHaveLength(count);
  });

  it('refuses a bad upload id, and needs binary()', () => {
    const { socket } = connected();
    expect(() =>
      socket.binary.upload('upload-attachment', file, { input: deck, uploadId: '' }),
    ).toThrow(LiveThingError);
    // The types refuse it too.
    expect(() => client()(connect('wss://test'), uploads() as never)).toThrow(LiveThingConfigError);
  });
});

describe("a plugin's scoped socket", () => {
  interface FilesWire {
    binary: {
      uploads: { 'store-file': { payload: { fileId: string }; response: { size: number } } };
    };
  }

  interface Host {
    binary: {
      uploads: {
        '__acme:files::store-file': { payload: { fileId: string }; response: { size: number } };
      };
    };
  }

  function withFiles() {
    let scoped!: Parameters<Parameters<ReturnType<typeof plugin<FilesWire>>>[0]['setup']>[0];
    const Files = plugin<FilesWire>()({
      id: 'acme:files',
      dependencies: [binary, uploads],
      setup(socket) {
        scoped = socket;
        return {};
      },
    });
    const socket = client<Host>()(connect('wss://test'), binary(), uploads(), Files());
    socket.connect();
    const ws = MockWebSocket.last();

    ws.open();

    return { scoped: () => scoped, ws };
  }

  it('uploads under the plugin prefix, and resolves with the reply', async () => {
    const { scoped, ws } = withFiles();
    const upload = scoped().binary.upload('store-file', file, {
      input: { fileId: 'f1' },
      uploadId: 'up-1',
    });
    const done = upload.start();
    await settle();
    expect(sent(ws)[0]).toMatchObject({
      event: '__acme:files::store-file',
      metadata: { upload: { id: 'up-1', size: 10 } },
    });

    ws.emit({
      event: '__uploadDone__',
      payload: { info: { size: 10 } },
      metadata: { upload: { id: 'up-1' } },
    });
    await expect(done).resolves.toEqual({ info: { size: 10 } });
  });

  it("rejects with the plugin's own error code, without the prefix", async () => {
    const { scoped, ws } = withFiles();
    const running = scoped()
      .binary.upload('store-file', file, { input: { fileId: 'f1' }, uploadId: 'up-1' })
      .start();
    await settle();
    ws.emit({
      event: '__error__',
      payload: { code: '__acme:files::files-full' },
      metadata: { upload: { id: 'up-1' } },
    });
    await expect(running).rejects.toMatchObject({ code: 'files-full' });
  });

  it('gives a channel handle no binary.upload: uploads are not channel events', () => {
    const socket = client<{
      channels: { rooms: { addressing: 'dynamic'; incoming: { message: { text: string } } } };
    }>()(connect('wss://test'), binary(), channels(), uploads());
    const room = socket.channel('rooms', 'room:general') as unknown as {
      binary?: { upload?: unknown };
    };
    expect(room.binary?.upload).toBeUndefined();
  });
});
