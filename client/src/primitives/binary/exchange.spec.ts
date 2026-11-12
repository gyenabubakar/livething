// Binary requests, binary server requests and binary streams on the client (binary spec
// 7.4, 7.5, 9.2, 9.3). The names and shapes are Huddle's.
import { LiveThingError, StreamAborted } from '@livething/core';
import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { Disconnected, StreamCorrupted, StreamOverflow, Timeout } from '~/errors.ts';
import { plugin } from '~/plugins/plugins.ts';
import { binary } from '~/primitives/binary/index.ts';
import { buffering } from '~/primitives/buffering/index.ts';
import { channels } from '~/primitives/channels/index.ts';
import { clientRequests } from '~/primitives/client-requests/index.ts';
import { serverRequests } from '~/primitives/server-requests/index.ts';
import { stream } from '~/primitives/stream/index.ts';
import {
  decodeSentFrame as decodeSent,
  binaryFrame as frame,
  installMockWebSocket,
  MockWebSocket,
} from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Primitive } from '~/primitives/types.ts';

type Attachment = { fileName: string; fileType: string } | null;

interface C {
  clientRequests: { 'get-room': { payload: { roomId: string }; response: { name: string } } };
  serverRequests: { 'confirm-delete': { payload: { preview: string }; response: unknown } };
  binary: {
    incoming: { 'avatar-preview': null };
    clientRequests: {
      'get-thumbnail': {
        payload: { attachmentId: string };
        response: { fileType: 'image/png' };
      };
    };
    serverRequests: {
      'capture-screen': { payload: { maxWidth: number }; response: { fileType: 'image/png' } };
    };
    streams: {
      'download-attachment': {
        payload: { attachmentId: string; fromByte: number };
        chunk: Attachment;
        kind: 'ephemeral';
        nudges: { pause: undefined };
      };
      'export-room-pdf': {
        payload: { roomId: string };
        chunk: { fileName: string } | null;
        kind: 'persistent';
      };
    };
  };
  channels: {
    rooms: {
      addressing: 'dynamic';
      binary: {
        clientRequests: {
          'get-whiteboard': { payload: null; response: { fileType: 'image/png' } };
        };
        serverRequests: {
          'capture-whiteboard': { payload: null; response: { fileType: 'image/png' } };
        };
        streams: {
          'download-recording': { payload: null; chunk: null; kind: 'ephemeral' };
          'export-whiteboard': { payload: null; chunk: null; kind: 'persistent' };
        };
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
  vi.useRealTimers();
});

function typedAsEverything() {
  return client<C>()(
    connect('wss://test'),
    binary(),
    channels(),
    clientRequests(),
    serverRequests(),
    stream(),
  );
}

/** An open socket with the given primitives, typed as if every primitive were there. */
function connected(...extras: Primitive[]) {
  const socket = client<C>()(
    connect('wss://test') as never,
    ...(extras as []),
  ) as unknown as ReturnType<typeof typedAsEverything>;
  socket.connect();
  const ws = MockWebSocket.last();
  ws.open();

  return { socket, ws };
}

function everything() {
  return connected(binary(), channels(), clientRequests(), serverRequests(), stream());
}

const thumbnail = new Uint8Array([137, 80, 78, 71, 13, 10]);
const general = { name: 'room:general', family: 'rooms' };

async function joinGeneral(socket: ReturnType<typeof everything>['socket'], ws: MockWebSocket) {
  const room = socket.channel('rooms', 'room:general');
  const joined = room.subscribe();
  ws.emit({ event: '__subscribeOk__', payload: null, metadata: { channel: general } });
  await joined;

  return room;
}

describe('socket.binary.request (spec 7.4, 9.3)', () => {
  it('sends one binary frame with a new exchange id, and resolves the binary reply', async () => {
    const { socket, ws } = everything();

    const reply = socket.binary.request('get-thumbnail', { attachmentId: 'att_1' });
    expect(ws.sent).toHaveLength(1);
    const sent = decodeSent(ws.sent[0]);
    expect(sent).toMatchObject({
      event: 'get-thumbnail',
      payload: { attachmentId: 'att_1' },
      metadata: { exchange: { source: 'client' } },
    });
    expect(sent.bytes!.byteLength).toBe(0);

    const exchange = sent.metadata!.exchange!;

    ws.emitRaw(frame('get-thumbnail', { fileType: 'image/png' }, { exchange }, thumbnail));

    const { info, bytes } = await reply;
    expect(info).toEqual({ fileType: 'image/png' });
    expect([...bytes]).toEqual([...thumbnail]);
  });

  it('uses the same id scheme as request, and sends the bytes it is given', () => {
    const { socket, ws } = everything();

    void socket.request('get-room', { roomId: 'room:general' });
    void socket.binary.request('get-thumbnail', { attachmentId: 'att_1' }, thumbnail.buffer);

    const textId = ws.sentFrames()[0].metadata.exchange.id as string;
    const sent = decodeSent(ws.sent[1]);
    expect(sent.metadata!.exchange!.id).toMatch(/^req/);
    expect(sent.metadata!.exchange!.id).not.toBe(textId);
    expect([...sent.bytes!]).toEqual([...thumbnail]);
  });

  it('takes undefined bytes with options, and rejects with Timeout', async () => {
    vi.useFakeTimers();
    const { socket, ws } = everything();

    const reply = socket.binary.request('get-thumbnail', { attachmentId: 'att_1' }, undefined, {
      timeout: 5_000,
    });
    expect(decodeSent(ws.sent[0]).bytes!.byteLength).toBe(0);
    const caught = reply.catch((error: unknown) => error);

    vi.advanceTimersByTime(5_000);
    expect(Timeout.matches(await caught)).toBe(true);
  });

  it('rejects with the typed error of a text __error__ reply', async () => {
    const { socket, ws } = everything();

    const reply = socket.binary.request('get-thumbnail', { attachmentId: 'att_404' });
    const exchange = decodeSent(ws.sent[0]).metadata!.exchange!;
    ws.emit({
      event: '__error__',
      payload: { code: 'not-found', detail: { id: 'att_404' } },
      metadata: { exchange },
    });

    await expect(reply).rejects.toMatchObject({ code: 'not-found', detail: { id: 'att_404' } });
  });

  it('rejects a text reply with request-invalid-response', async () => {
    const { socket, ws } = everything();

    const reply = socket.binary.request('get-thumbnail', { attachmentId: 'att_1' });
    const exchange = decodeSent(ws.sent[0]).metadata!.exchange!;
    ws.emit({ event: 'get-thumbnail', payload: { fileType: 'image/png' }, metadata: { exchange } });

    const error = await reply.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LiveThingError);
    expect(error).toMatchObject({
      code: 'request-invalid-response',
      detail: {
        event: 'get-thumbnail',
        issues: [{ message: 'The reply must be a binary frame.' }],
      },
    });
  });

  it('does not settle a JSON request with a binary reply: it waits for its text reply', async () => {
    const { socket, ws } = everything();

    const reply = socket.request('get-room', { roomId: 'room:general' });
    const exchange = ws.sentFrames()[0].metadata.exchange;
    ws.emitRaw(frame('get-room', { name: 'Wrong' }, { exchange }, thumbnail));
    ws.emit({ event: 'get-room', payload: { name: 'General' }, metadata: { exchange } });

    await expect(reply).resolves.toEqual({ name: 'General' });
  });

  it('on a lazy socket, a request that is rejected before sending opens no WebSocket', async () => {
    const socket = client<C>()(
      connect('wss://test', { lazy: true }),
      binary({ maxFrameBytes: 100 }),
      clientRequests(),
    ) as unknown as ReturnType<typeof typedAsEverything>;

    await expect(
      socket.binary.request('get-thumbnail', { attachmentId: 'att_1' }, new Uint8Array(100)),
    ).rejects.toThrow(/maxFrameBytes/);
    await expect(
      socket.binary.request('get-thumbnail', { attachmentId: 'att_1' }, 'bytes' as never),
    ).rejects.toThrow(TypeError);
    expect(MockWebSocket.instances).toHaveLength(0);
    expect(socket.state.get()).toBe('closed');
  });

  it('rejects with Disconnected when the socket closes while it waits', async () => {
    const { socket, ws } = everything();

    const reply = socket.binary.request('get-thumbnail', { attachmentId: 'att_1' });
    ws.serverClose(1006);

    expect(Disconnected.matches(await reply.catch((error: unknown) => error))).toBe(true);
  });

  it('drops a reply that comes after the request settled, without giving it to binary.on', async () => {
    vi.useFakeTimers();
    const { socket, ws } = everything();
    const listener = vi.fn();
    socket.binary.on('get-thumbnail' as 'avatar-preview', listener);

    const reply = socket.binary.request('get-thumbnail', { attachmentId: 'att_1' }, undefined, {
      timeout: 10,
    });
    const caught = reply.catch(() => 'timed out');
    vi.advanceTimersByTime(10);
    await caught;

    const exchange = decodeSent(ws.sent[0]).metadata!.exchange!;
    ws.emitRaw(frame('get-thumbnail', { fileType: 'image/png' }, { exchange }, thumbnail));
    expect(listener).not.toHaveBeenCalled();
  });

  it('rejects, and sends nothing, when the frame is over maxFrameBytes or the bytes are wrong', async () => {
    const { socket, ws } = connected(binary({ maxFrameBytes: 100 }), clientRequests());

    await expect(
      socket.binary.request('get-thumbnail', { attachmentId: 'att_1' }, new Uint8Array(100)),
    ).rejects.toThrow(/maxFrameBytes/);
    await expect(
      socket.binary.request('get-thumbnail', { attachmentId: 'att_1' }, 'bytes' as never),
    ).rejects.toThrow(TypeError);
    expect(ws.sent).toHaveLength(0);
  });

  it('waits in the buffering() queue while offline, and goes out as a binary frame', async () => {
    const socket = client<C>()(
      connect('wss://test'),
      binary(),
      buffering(),
      clientRequests(),
    ) as unknown as ReturnType<typeof typedAsEverything>;

    const reply = socket.binary.request('get-thumbnail', { attachmentId: 'att_1' }, thumbnail);
    socket.connect();
    const ws = MockWebSocket.last();
    ws.open();

    const sent = decodeSent(ws.sent[0]);
    expect([...sent.bytes!]).toEqual([...thumbnail]);
    ws.emitRaw(
      frame('get-thumbnail', { fileType: 'image/png' }, { exchange: sent.metadata!.exchange! }),
    );
    await expect(reply).resolves.toMatchObject({ info: { fileType: 'image/png' } });
  });

  it('on a channel, sends the channel metadata and needs the channel to be subscribed', async () => {
    const { socket, ws } = everything();
    const unjoined = socket.channel('rooms', 'room:design');
    expect(() => unjoined.binary.request('get-whiteboard', null)).toThrow(/channel-not-subscribed/);

    const room = await joinGeneral(socket, ws);
    const reply = room.binary.request('get-whiteboard', null);
    const sent = decodeSent(ws.sent.at(-1));
    expect(sent.metadata).toMatchObject({ channel: general, exchange: { source: 'client' } });

    ws.emitRaw(frame('get-whiteboard', { fileType: 'image/png' }, sent.metadata!, thumbnail));
    await expect(reply).resolves.toMatchObject({ info: { fileType: 'image/png' } });
  });

  it('does not exist without clientRequests(), and its reply frame is dropped', () => {
    const { socket, ws } = connected(binary());
    expect((socket.binary as unknown as Record<string, unknown>).request).toBeUndefined();

    const listener = vi.fn();
    socket.binary.on('get-thumbnail' as 'avatar-preview', listener);
    ws.emitRaw(frame('get-thumbnail', null, { exchange: { id: 'req-1', source: 'client' } }));
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('without binary()', () => {
  it('clientRequests(), serverRequests() and stream() add no .binary, on the socket or a channel', () => {
    const { socket } = connected(channels(), clientRequests(), serverRequests(), stream());

    expect((socket as unknown as Record<string, unknown>).binary).toBeUndefined();
    const room = socket.channel('rooms', 'room:general');
    expect((room as unknown as Record<string, unknown>).binary).toBeUndefined();
  });
});

describe('socket.binary.onRequest (spec 7.4)', () => {
  it('answers with one binary frame with the same exchange, from (info, bytes)', async () => {
    const { socket, ws } = everything();
    const handler = vi.fn(async (info: { maxWidth: number }, bytes: Uint8Array) => ({
      info: { fileType: 'image/png' as const },
      bytes: new Uint8Array([info.maxWidth % 256, bytes.byteLength]),
    }));
    socket.binary.onRequest('capture-screen', handler);

    const exchange = { id: 'x-1', source: 'server' as const };
    ws.emitRaw(frame('capture-screen', { maxWidth: 1280 }, { exchange }, new Uint8Array(3)));
    await vi.waitFor(() => expect(ws.sent).toHaveLength(1));

    expect(handler).toHaveBeenCalledWith({ maxWidth: 1280 }, expect.any(Uint8Array));
    const answer = decodeSent(ws.sent[0]);
    expect(answer).toMatchObject({
      event: 'capture-screen',
      payload: { fileType: 'image/png' },
      metadata: { exchange },
    });
    expect([...answer.bytes!]).toEqual([1280 % 256, 3]);
  });

  it('sends zero bytes when the answer has none', async () => {
    const { socket, ws } = everything();
    socket.binary.onRequest('capture-screen', () => ({ info: { fileType: 'image/png' } }));

    ws.emitRaw(
      frame('capture-screen', { maxWidth: 1 }, { exchange: { id: 'x-1', source: 'server' } }),
    );
    await vi.waitFor(() => expect(ws.sent).toHaveLength(1));
    expect(decodeSent(ws.sent[0]).bytes!.byteLength).toBe(0);
  });

  it('declines with a text request-no-response when the handler throws or answers wrongly', async () => {
    const { socket, ws } = everything();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    socket.binary.onRequest('capture-screen', () => {
      throw new Error('no screen');
    });
    const room = await joinGeneral(socket, ws);
    room.binary.onRequest('capture-whiteboard', () => ({
      info: { fileType: 'image/png' },
      bytes: 'not bytes' as never,
    }));

    ws.sent.length = 0;

    ws.emitRaw(
      frame('capture-screen', { maxWidth: 1 }, { exchange: { id: 'x-1', source: 'server' } }),
    );
    ws.emitRaw(
      frame('capture-whiteboard', null, {
        exchange: { id: 'x-2', source: 'server' },
        channel: general,
      }),
    );
    await vi.waitFor(() => expect(ws.sent).toHaveLength(2));

    expect(ws.sent.every((data) => typeof data === 'string')).toBe(true);
    expect(ws.sentFrames()).toEqual([
      {
        event: '__error__',
        payload: { code: 'request-no-response' },
        metadata: { exchange: { id: 'x-1', source: 'server' } },
      },
      {
        event: '__error__',
        payload: { code: 'request-no-response' },
        metadata: { exchange: { id: 'x-2', source: 'server' }, channel: general },
      },
    ]);
  });

  it('a JSON onRequest does not answer a binary request, nor binary.onRequest a JSON one', async () => {
    const { socket, ws } = everything();
    const json = vi.fn(() => ({ ok: true }));
    const bytes = vi.fn(() => ({ info: { fileType: 'image/png' as const } }));
    socket.onRequest('capture-screen' as 'confirm-delete', json);
    socket.binary.onRequest('confirm-delete' as 'capture-screen', bytes);

    ws.emitRaw(
      frame('capture-screen', { maxWidth: 1 }, { exchange: { id: 'x-1', source: 'server' } }),
    );
    ws.emit({
      event: 'confirm-delete',
      payload: { preview: 'hi' },
      metadata: { exchange: { id: 'x-2', source: 'server' } },
    });
    await vi.waitFor(() => expect(ws.sent).toHaveLength(2));

    expect(json).not.toHaveBeenCalled();
    expect(bytes).not.toHaveBeenCalled();
    expect(ws.sentFrames().map((sent) => sent.payload)).toEqual([
      { code: 'request-no-response' },
      { code: 'request-no-response' },
    ]);
  });

  it('a channel handler answers only its channel, with the channel on the answer', async () => {
    const { socket, ws } = everything();
    const room = await joinGeneral(socket, ws);
    room.binary.onRequest('capture-whiteboard', () => ({
      info: { fileType: 'image/png' },
      bytes: thumbnail,
    }));
    ws.sent.length = 0;

    ws.emitRaw(frame('capture-whiteboard', null, { exchange: { id: 'x-1', source: 'server' } }));
    ws.emitRaw(
      frame('capture-whiteboard', null, {
        exchange: { id: 'x-2', source: 'server' },
        channel: general,
      }),
    );
    await vi.waitFor(() => expect(ws.sent).toHaveLength(2));

    expect(ws.sentFrames()[0]).toMatchObject({
      event: '__error__',
      metadata: { exchange: { id: 'x-1' } },
    });
    const answer = decodeSent(ws.sent[1]);
    expect(answer.metadata).toEqual({
      exchange: { id: 'x-2', source: 'server' },
      channel: general,
    });
    expect([...answer.bytes!]).toEqual([...thumbnail]);
  });

  it('declines an answer that is not { info, bytes? }, such as the info alone', async () => {
    const { socket, ws } = everything();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const answers: unknown[] = [{ fileType: 'image/png' }, null, 'image/png'];
    socket.binary.onRequest('capture-screen', () => answers.shift() as never);

    for (const id of ['x-1', 'x-2', 'x-3']) {
      ws.emitRaw(frame('capture-screen', { maxWidth: 1 }, { exchange: { id, source: 'server' } }));
    }

    await vi.waitFor(() => expect(ws.sent).toHaveLength(3));
    expect(ws.sent.every((data) => typeof data === 'string')).toBe(true);
    expect(ws.sentFrames().map((sent) => sent.payload)).toEqual([
      { code: 'request-no-response' },
      { code: 'request-no-response' },
      { code: 'request-no-response' },
    ]);
  });

  it('stops answering after its unsubscribe', () => {
    const { socket, ws } = everything();
    const handler = vi.fn(() => ({ info: { fileType: 'image/png' as const } }));
    socket.binary.onRequest('capture-screen', handler)();

    ws.emitRaw(
      frame('capture-screen', { maxWidth: 1 }, { exchange: { id: 'x-1', source: 'server' } }),
    );
    expect(handler).not.toHaveBeenCalled();
    expect(ws.sentFrames()[0].payload).toEqual({ code: 'request-no-response' });
  });
});

/** Start a binary download and confirm it, as the server would. */
async function startDownload(socket: ReturnType<typeof everything>['socket'], ws: MockWebSocket) {
  const started = socket.binary.stream('download-attachment', {
    attachmentId: 'att_1',
    fromByte: 0,
  });
  const trigger = decodeSent(ws.sent.at(-1));
  const id = trigger.metadata!.stream!.id;
  ws.emit({
    event: '__streamOk__',
    payload: null,
    metadata: { stream: { id, durability: 'ephemeral' } },
  });

  return { download: await started, id, trigger };
}

// oxlint-disable-next-line max-params -- mirrors the frame: socket, id, seq, info, bytes
function piece(ws: MockWebSocket, id: string, seq: number, info: Attachment, bytes: Uint8Array) {
  ws.emitRaw(
    frame('download-attachment', info, { stream: { id, durability: 'ephemeral', seq } }, bytes),
  );
}

function endOf(ws: MockWebSocket, id: string, seq: number): void {
  ws.emit({ event: '__streamEnd__', payload: null, metadata: { stream: { id, seq } } });
}

async function readAll<T>(handle: AsyncIterable<T>): Promise<{ items: T[]; error?: unknown }> {
  const items: T[] = [];
  try {
    for await (const item of handle) items.push(item);
  } catch (error) {
    return { items, error };
  }

  return { items };
}

describe('socket.binary.stream (spec 7.5, 9.2)', () => {
  it('starts with a binary frame of zero bytes, gives { info, bytes } and ends on the text end', async () => {
    const { socket, ws } = everything();
    const { download, id, trigger } = await startDownload(socket, ws);
    expect(trigger).toMatchObject({
      event: 'download-attachment',
      payload: { attachmentId: 'att_1', fromByte: 0 },
    });
    expect(trigger.bytes!.byteLength).toBe(0);

    piece(ws, id, 1, { fileName: 'launch-plan.pdf', fileType: 'application/pdf' }, thumbnail);
    piece(ws, id, 2, null, new Uint8Array([1, 2]));
    endOf(ws, id, 2);

    const { items, error } = await readAll(download);
    expect(error).toBeUndefined();
    expect(items.map(({ info }) => info)).toEqual([
      { fileName: 'launch-plan.pdf', fileType: 'application/pdf' },
      null,
    ]);
    expect(items.map(({ bytes }) => [...bytes])).toEqual([[...thumbnail], [1, 2]]);
  });

  it('sends the start bytes it is given', () => {
    const { socket, ws } = everything();
    void socket.binary.stream(
      'download-attachment',
      { attachmentId: 'att_1', fromByte: 0 },
      thumbnail,
      { streamId: 'download-1' },
    );

    const trigger = decodeSent(ws.sent[0]);
    expect(trigger.metadata).toEqual({ stream: { id: 'download-1' } });
    expect([...trigger.bytes!]).toEqual([...thumbnail]);
  });

  it('fails with StreamCorrupted and cancels on a missing chunk, or a missing last chunk', async () => {
    const { socket, ws } = everything();
    const first = await startDownload(socket, ws);
    piece(ws, first.id, 1, null, thumbnail);
    piece(ws, first.id, 3, null, thumbnail);

    const gap = await readAll(first.download);
    expect(gap.items).toHaveLength(1);
    expect(StreamCorrupted.matches(gap.error)).toBe(true);
    expect(gap.error).toMatchObject({ detail: { expected: 2, got: 3 } });
    expect(ws.sentFrames().filter((sent) => sent.event === '__streamCancel__')).toEqual([
      { event: '__streamCancel__', payload: null, metadata: { stream: { id: first.id } } },
    ]);

    const second = await startDownload(socket, ws);
    piece(ws, second.id, 1, null, thumbnail);
    endOf(ws, second.id, 2);
    const atEnd = await readAll(second.download);
    expect(atEnd.error).toMatchObject({
      code: 'stream-corrupted',
      detail: { expected: 2, got: 1 },
    });
  });

  it('drops a text chunk, so the seq check catches it', async () => {
    const { socket, ws } = everything();
    const { download, id } = await startDownload(socket, ws);
    ws.emit({
      event: 'download-attachment',
      payload: null,
      metadata: { stream: { id, seq: 1 } },
    });
    piece(ws, id, 2, null, thumbnail);

    const { items, error } = await readAll(download);
    expect(items).toEqual([]);
    expect(error).toMatchObject({ code: 'stream-corrupted', detail: { expected: 1, got: 2 } });
  });

  it('throws the typed error of a text terminal __error__', async () => {
    const { socket, ws } = everything();
    const { download, id } = await startDownload(socket, ws);
    piece(ws, id, 1, null, thumbnail);
    ws.emit({
      event: '__error__',
      payload: { code: 'not-found', detail: { id: 'att_1' } },
      metadata: { stream: { id, terminated: true } },
    });

    const { items, error } = await readAll(download);
    expect(items).toHaveLength(1);
    expect(error).toMatchObject({ code: 'not-found' });
  });

  it('ends with StreamAborted on a hibernation wake, as a JSON stream does (spec 8.8)', async () => {
    const { socket, ws } = everything();
    const { download, id } = await startDownload(socket, ws);
    ws.emit({
      event: '__error__',
      payload: { code: 'stream-aborted', detail: { reason: 'hibernation-wake' } },
      metadata: { stream: { id, terminated: true } },
    });

    const { error } = await readAll(download);
    expect(StreamAborted.matches(error)).toBe(true);
    expect(ws.sentFrames().some((sent) => sent.event === '__continueStream__')).toBe(false);
  });

  it('a break sends a text __streamCancel__, and a nudge is a text frame', async () => {
    const { socket, ws } = everything();
    const { download, id } = await startDownload(socket, ws);

    void download.nudge('pause');
    const nudge = ws.sent.at(-1);
    expect(typeof nudge).toBe('string');
    expect(ws.sentFrames().at(-1)).toMatchObject({ event: 'pause', metadata: { stream: { id } } });

    piece(ws, id, 1, null, thumbnail);
    for await (const _chunk of download) break;

    expect(typeof ws.sent.at(-1)).toBe('string');
    expect(ws.sentFrames().at(-1)).toEqual({
      event: '__streamCancel__',
      payload: null,
      metadata: { stream: { id } },
    });
  });

  it('cancel() ends the loop without an error', async () => {
    const { socket, ws } = everything();
    const { download } = await startDownload(socket, ws);
    download.cancel();

    expect(await readAll(download)).toEqual({ items: [] });
    expect(ws.sentFrames().at(-1).event).toBe('__streamCancel__');
  });

  it('throws Disconnected when the socket closes', async () => {
    const { socket, ws } = everything();
    const { download } = await startDownload(socket, ws);
    ws.serverClose(1006);

    expect(Disconnected.matches((await readAll(download)).error)).toBe(true);
  });

  it('rejects, and sends nothing, when the start frame is over maxFrameBytes', async () => {
    const { socket, ws } = connected(binary({ maxFrameBytes: 100 }), stream());

    await expect(
      socket.binary.stream(
        'download-attachment',
        { attachmentId: 'att_1', fromByte: 0 },
        new Uint8Array(100),
      ),
    ).rejects.toThrow(/maxFrameBytes/);
    expect(ws.sent).toHaveLength(0);
  });

  it('on a channel, sends the channel metadata and needs the channel to be subscribed', async () => {
    const { socket, ws } = everything();
    expect(() =>
      socket.channel('rooms', 'room:design').binary.stream('download-recording', null),
    ).toThrow(/channel-not-subscribed/);

    const room = await joinGeneral(socket, ws);
    void room.binary.stream('download-recording', null);
    expect(decodeSent(ws.sent.at(-1)).metadata).toMatchObject({
      channel: general,
      stream: { id: expect.any(String) },
    });
  });

  it('does not exist without stream(), and a binary chunk is dropped', () => {
    const { socket, ws } = connected(binary());
    expect((socket.binary as unknown as Record<string, unknown>).stream).toBeUndefined();
    expect((socket.binary as unknown as Record<string, unknown>).onStream).toBeUndefined();
    expect((socket.binary as unknown as Record<string, unknown>).continueStream).toBeUndefined();

    const listener = vi.fn();
    socket.binary.on('download-attachment' as 'avatar-preview', listener);
    piece(ws, 'download-1', 1, null, thumbnail);
    expect(listener).not.toHaveBeenCalled();
  });
});

// oxlint-disable-next-line max-params -- mirrors the frame: socket, id, seq, info, bytes
function pdfPiece(ws: MockWebSocket, id: string, seq: number, info: unknown, bytes: Uint8Array) {
  ws.emitRaw(
    frame('export-room-pdf', info, { stream: { id, durability: 'persistent', seq } }, bytes),
  );
}

describe('socket.binary.continueStream (binary spec 8.4)', () => {
  it('sends a text __continueStream__, and gives the stored binary chunks after lastKnownSeq as { info, bytes }', async () => {
    const { socket, ws } = everything();
    const pdf = socket.binary.continueStream('export-room-pdf', 'pdf-1', { lastKnownSeq: 2 });

    expect(ws.sentFrames().at(-1)).toEqual({
      event: '__continueStream__',
      payload: { lastKnownSeq: 2 },
      metadata: { stream: { id: 'pdf-1' } },
    });
    pdfPiece(ws, 'pdf-1', 3, null, new Uint8Array([3, 3]));
    pdfPiece(ws, 'pdf-1', 4, null, new Uint8Array([4]));
    endOf(ws, 'pdf-1', 4);

    const { items, error } = await readAll(pdf);
    expect(error).toBeUndefined();
    expect(items.map(({ info, bytes }) => [info, [...bytes]])).toEqual([
      [null, [3, 3]],
      [null, [4]],
    ]);
  });

  it('drops a text chunk, so the seq check catches the hole it leaves', async () => {
    const { socket, ws } = everything();
    const pdf = socket.binary.continueStream('export-room-pdf', 'pdf-1', { lastKnownSeq: 2 });

    ws.emit({
      event: 'export-room-pdf',
      payload: null,
      metadata: { stream: { id: 'pdf-1', durability: 'persistent', seq: 3 } },
    });
    pdfPiece(ws, 'pdf-1', 4, null, new Uint8Array([4]));

    const { items, error } = await readAll(pdf);
    expect(items).toEqual([]);
    expect(StreamCorrupted.matches(error)).toBe(true);
  });

  it('continues by itself after a hibernation wake, from the last chunk it got (spec 8.8)', async () => {
    const { socket, ws } = everything();
    const pdf = socket.binary.continueStream('export-room-pdf', 'pdf-1');
    pdfPiece(ws, 'pdf-1', 1, { fileName: 'room-design.pdf' }, new Uint8Array([1]));
    ws.emit({
      event: '__error__',
      payload: { code: 'stream-aborted', detail: { reason: 'hibernation-wake' } },
      metadata: { stream: { id: 'pdf-1', terminated: true } },
    });

    expect(ws.sentFrames().at(-1)).toMatchObject({
      event: '__continueStream__',
      payload: { lastKnownSeq: 1 },
    });
    pdfPiece(ws, 'pdf-1', 2, null, new Uint8Array([2]));
    endOf(ws, 'pdf-1', 2);

    const { items, error } = await readAll(pdf);
    expect(error).toBeUndefined();
    expect(items.map(({ bytes }) => [...bytes])).toEqual([[1], [2]]);
  });

  it('on a channel, sends the channel metadata and needs the channel to be subscribed', async () => {
    const { socket, ws } = everything();
    expect(() =>
      socket.channel('rooms', 'room:design').binary.continueStream('export-whiteboard', 'wb-1'),
    ).toThrow();

    const room = await joinGeneral(socket, ws);
    void room.binary.continueStream('export-whiteboard', 'wb-1');
    expect(ws.sentFrames().at(-1)).toEqual({
      event: '__continueStream__',
      payload: {},
      metadata: { stream: { id: 'wb-1' }, channel: general },
    });
  });
});

describe('binary.onStream (spec 7.5)', () => {
  it('gives each broadcast chunk as { info, bytes }, then onEnd', () => {
    const { socket, ws } = everything();
    const onChunk = vi.fn();
    const onEnd = vi.fn();
    socket.binary.onStream('download-attachment', { onChunk, onEnd });

    piece(ws, 'download-9', 4, { fileName: 'a.pdf', fileType: 'application/pdf' }, thumbnail);
    piece(ws, 'download-9', 5, null, new Uint8Array([7]));
    endOf(ws, 'download-9', 5);

    expect(onChunk.mock.calls.map(([chunk, id]) => [chunk.info, [...chunk.bytes], id])).toEqual([
      [{ fileName: 'a.pdf', fileType: 'application/pdf' }, [...thumbnail], 'download-9'],
      [null, [7], 'download-9'],
    ]);
    expect(onEnd).toHaveBeenCalledWith('download-9', 5);
  });

  it('a JSON onStream does not get binary chunks, nor binary.onStream JSON chunks', () => {
    const { socket, ws } = everything();
    const json = vi.fn();
    const bytes = vi.fn();
    socket.onStream('download-attachment' as never, { onChunk: json });
    socket.binary.onStream('download-attachment', { onChunk: bytes });

    piece(ws, 'download-9', 1, null, thumbnail);
    ws.emit({
      event: 'download-attachment',
      payload: { row: 1 },
      metadata: { stream: { id: 'download-8', seq: 1 } },
    });

    expect(json.mock.calls.map(([chunk]) => chunk)).toEqual([{ row: 1 }]);
    expect(bytes.mock.calls.map(([chunk]) => chunk.info)).toEqual([null]);
  });

  it('gives the end, the error and the timeout of a run only to listeners of its kind', () => {
    vi.useFakeTimers();
    const { socket, ws } = connected(binary(), stream({ timeout: 1_000 }));
    const json = { onChunk: vi.fn(), onEnd: vi.fn(), onError: vi.fn(), onTimeout: vi.fn() };
    const bytes = { onChunk: vi.fn(), onEnd: vi.fn(), onError: vi.fn(), onTimeout: vi.fn() };
    socket.onStream('download-attachment' as never, json);

    socket.binary.onStream('download-attachment', bytes);

    piece(ws, 'download-1', 1, null, thumbnail);
    endOf(ws, 'download-1', 1);
    piece(ws, 'download-2', 1, null, thumbnail);
    ws.emit({
      event: '__error__',
      payload: { code: 'not-found' },
      metadata: { stream: { id: 'download-2', terminated: true } },
    });
    piece(ws, 'download-3', 1, null, thumbnail);

    vi.advanceTimersByTime(1_000);

    expect(bytes.onEnd).toHaveBeenCalledTimes(1);
    expect(bytes.onError).toHaveBeenCalledTimes(1);
    expect(bytes.onTimeout).toHaveBeenCalledTimes(1);
    expect(json.onEnd).not.toHaveBeenCalled();
    expect(json.onError).not.toHaveBeenCalled();

    expect(json.onTimeout).not.toHaveBeenCalled();
  });

  it('a channel handle gets only its own channel stream, and fails on a gap', async () => {
    const { socket, ws } = everything();
    const room = await joinGeneral(socket, ws);
    const onChunk = vi.fn();
    const onError = vi.fn();
    room.binary.onStream('download-recording', { onChunk, onError });

    function inRoom(seq: number): ArrayBuffer {
      const metadata = { stream: { id: 'rec-1', seq }, channel: general };
      return frame('download-recording', null, metadata, thumbnail);
    }

    ws.emitRaw(frame('download-recording', null, { stream: { id: 'rec-2', seq: 1 } }, thumbnail));
    ws.emitRaw(inRoom(1));
    ws.emitRaw(inRoom(3));

    expect(onChunk).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'stream-corrupted' }),
      'rec-1',
    );
  });
});

describe('plugin scoped sockets (spec 7.6)', () => {
  interface RecorderWire {
    binary: {
      clientRequests: { 'get-clip': { payload: null; response: null } };
      serverRequests: { 'capture-clip': { payload: null; response: null } };
      streams: { 'download-clip': { payload: null; chunk: null; kind: 'ephemeral' } };
    };
  }

  interface Host {
    binary: {
      clientRequests: { '__acme:recorder::get-clip': { payload: null; response: null } };
      serverRequests: { '__acme:recorder::capture-clip': { payload: null; response: null } };
      streams: {
        '__acme:recorder::download-clip': { payload: null; chunk: null; kind: 'ephemeral' };
      };
    };
  }

  it('gets binary requests, server requests and streams with the plugin prefix', async () => {
    let scoped: Parameters<Parameters<ReturnType<typeof plugin<RecorderWire>>>[0]['setup']>[0];
    const Recorder = plugin<RecorderWire>()({
      id: 'acme:recorder',
      dependencies: [binary, clientRequests, serverRequests, stream],
      setup(socket) {
        scoped = socket;
        socket.binary.onRequest('capture-clip', () => ({ info: null, bytes: thumbnail }));
        return {};
      },
    });
    const socket = client<Host>()(
      connect('wss://test'),
      binary(),
      clientRequests(),
      serverRequests(),
      stream(),
      Recorder(),
    );
    socket.connect();
    const ws = MockWebSocket.last();

    ws.open();

    const clip = scoped!.binary.request('get-clip', null);
    const request = decodeSent(ws.sent[0]);
    expect(request.event).toBe('__acme:recorder::get-clip');
    ws.emitRaw(frame('__acme:recorder::get-clip', null, request.metadata!, thumbnail));
    expect([...(await clip).bytes]).toEqual([...thumbnail]);

    void scoped!.binary.stream('download-clip', null);
    expect(decodeSent(ws.sent[1]).event).toBe('__acme:recorder::download-clip');

    ws.emitRaw(
      frame('__acme:recorder::capture-clip', null, { exchange: { id: 'x-1', source: 'server' } }),
    );
    await vi.waitFor(() => expect(ws.sent).toHaveLength(3));
    expect(decodeSent(ws.sent[2]).event).toBe('__acme:recorder::capture-clip');
  });

  it('names the missing primitive when a plugin uses binary.request without it', () => {
    let scoped: { binary: { request: (...args: unknown[]) => unknown } } | undefined;
    const Recorder = plugin<RecorderWire>()({
      id: 'acme:recorder',
      dependencies: [binary],
      setup(socket) {
        scoped = socket as never;
        return {};
      },
    });
    client<Host>()(connect('wss://test'), binary(), Recorder());

    expect(() => scoped!.binary.request('get-clip', null)).toThrow(/clientRequests/);
  });

  it('names binary() when binary() is the missing one', () => {
    let scoped: { binary: Record<string, (...args: unknown[]) => unknown> } | undefined;
    const Recorder = plugin<RecorderWire>()({
      id: 'acme:recorder',
      setup(socket) {
        scoped = socket as never;
        return {};
      },
    });
    client<Host>()(
      connect('wss://test') as never,
      clientRequests(),
      serverRequests(),
      stream(),
      Recorder(),
    );

    for (const method of ['request', 'onRequest', 'stream', 'onStream', 'continueStream']) {
      expect(() => scoped!.binary[method]!('x', null)).toThrow(/the binary primitive/);
    }
  });

  it('names stream() when a plugin uses binary.continueStream without it', () => {
    let scoped: { binary: { continueStream: (...args: unknown[]) => unknown } } | undefined;
    const Recorder = plugin<RecorderWire>()({
      id: 'acme:recorder',
      dependencies: [binary],
      setup(socket) {
        scoped = socket as never;
        return {};
      },
    });
    client<Host>()(connect('wss://test'), binary(), Recorder());

    expect(() => scoped!.binary.continueStream('download-clip', 'clip-1')).toThrow(
      /the stream primitive/,
    );
  });
});

describe('binary exchange limits and defaults', () => {
  it('a binary request takes its default timeout from clientRequests({ timeout })', async () => {
    vi.useFakeTimers();
    const { socket } = connected(binary(), clientRequests({ timeout: 2_000 }));
    const caught = socket.binary
      .request('get-thumbnail', { attachmentId: 'att_1' })
      .catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(1_999);
    vi.advanceTimersByTime(1);
    expect(Timeout.matches(await caught)).toBe(true);
  });

  it('rejects a request or a stream start over maxFrameBytes with a RangeError', async () => {
    const { socket } = connected(binary({ maxFrameBytes: 100 }), clientRequests(), stream());

    await expect(
      socket.binary.request('get-thumbnail', { attachmentId: 'att_1' }, new Uint8Array(100)),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      socket.binary.stream(
        'download-attachment',
        { attachmentId: 'att_1', fromByte: 0 },
        new Uint8Array(100),
      ),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it('a second binary.onRequest handler for the same event replaces the first', async () => {
    const { socket, ws } = everything();
    const first = vi.fn(() => ({ info: { fileType: 'image/png' as const } }));
    const second = vi.fn(() => ({ info: { fileType: 'image/png' as const }, bytes: thumbnail }));
    socket.binary.onRequest('capture-screen', first);
    socket.binary.onRequest('capture-screen', second);

    ws.emitRaw(
      frame('capture-screen', { maxWidth: 1 }, { exchange: { id: 'x-1', source: 'server' } }),
    );
    await vi.waitFor(() => expect(ws.sent).toHaveLength(1));

    expect(first).not.toHaveBeenCalled();
    expect([...decodeSent(ws.sent[0]).bytes!]).toEqual([...thumbnail]);
  });

  it('never sends a binary.onRequest answer over maxFrameBytes', async () => {
    const { socket, ws } = connected(binary({ maxFrameBytes: 100 }), serverRequests());
    socket.binary.onRequest('capture-screen', () => ({
      info: { fileType: 'image/png' as const },
      bytes: new Uint8Array(200),
    }));

    ws.emitRaw(
      frame('capture-screen', { maxWidth: 1 }, { exchange: { id: 'x-1', source: 'server' } }),
    );
    await vi.waitFor(() => expect(ws.sent).toHaveLength(1));

    expect(typeof ws.sent[0]).toBe('string');
    expect(ws.sentFrames()[0].payload).toEqual({ code: 'request-no-response' });
  });

  it('a binary stream throws Timeout when no chunk comes in time', async () => {
    vi.useFakeTimers();
    const { socket, ws } = connected(binary(), stream({ timeout: 1_000 }));
    const { download } = await startDownload(socket, ws);
    const read = readAll(download);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(Timeout.matches((await read).error)).toBe(true);
  });

  it('counts the bytes of binary chunks toward stream({ maxBytes })', async () => {
    const { socket, ws } = connected(binary(), stream({ maxBytes: 50 }));
    const { download, id } = await startDownload(socket, ws);

    piece(ws, id, 1, null, new Uint8Array(30));
    piece(ws, id, 2, null, new Uint8Array(30));

    expect(StreamOverflow.matches((await readAll(download)).error)).toBe(true);
  });

  it('without serverRequests(), a binary server request in a channel reaches no listener', async () => {
    const { socket, ws } = connected(binary(), channels());
    const room = await joinGeneral(socket as ReturnType<typeof everything>['socket'], ws);
    const listener = vi.fn();
    (room.binary as unknown as { on: (event: string, fn: () => void) => void }).on(
      'capture-whiteboard',
      listener,
    );
    ws.sent.length = 0;

    ws.emitRaw(
      frame('capture-whiteboard', null, {
        exchange: { id: 'x-1', source: 'server' },
        channel: general,
      }),
    );

    expect(listener).not.toHaveBeenCalled();
    expect(ws.sent).toHaveLength(0);
  });
});
