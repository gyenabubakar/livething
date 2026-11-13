import { encodeBinaryFrame, splitBinaryFrame } from '@livething/core';
import { hash, pattern } from '@livething/tests-e2e-handlers/_shared/bytes';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';

// Binary frames and uploads on a hibernating Durable Object. Under hibernation, Cloudflare
// hands each message to `webSocketMessage`, not to a socket listener, and an evicted object
// wakes with no memory: these tests check both paths in real workerd.

interface Frame {
  event: string;
  payload: unknown;
  metadata: { exchange?: { id: string }; stream?: { id: string; seq?: number } } | null;
  bytes?: Uint8Array;
}

const PIECE = 64 * 1024;

async function open(
  namespace: DurableObjectNamespace,
  instance: string,
): Promise<{ stub: DurableObjectStub; socket: WebSocket; frames: Frame[] }> {
  const stub = namespace.get(namespace.idFromName(instance));
  const response = (await stub.fetch('https://hibernation.test/?username=amara', {
    headers: { Upgrade: 'websocket' },
  })) as Response & { webSocket: WebSocket };
  const socket = response.webSocket;
  socket.binaryType = 'arraybuffer';
  socket.accept();

  const frames: Frame[] = [];
  socket.addEventListener('message', ({ data }) => {
    if (typeof data === 'string') {
      const [event, payload, metadata] = JSON.parse(data);
      frames.push({ event, payload, metadata });
      return;
    }

    const split = splitBinaryFrame(data as ArrayBuffer);
    if (split.kind !== 'frame') throw new Error('the server sent a broken binary frame');

    const [event, payload, metadata] = JSON.parse(split.envelope);
    frames.push({ event, payload, metadata, bytes: split.bytes });
  });

  return { stub, socket, frames };
}

async function waitFor(frames: Frame[], match: (frame: Frame) => boolean): Promise<Frame> {
  for (let tries = 0; tries < 200; tries += 1) {
    const frame = frames.find(match);
    if (frame) return frame;

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(
    `no matching frame; got ${JSON.stringify(frames.map(({ bytes: _, ...rest }) => rest))}`,
  );
}

function sendBinary(socket: WebSocket, frame: unknown[], bytes?: Uint8Array): void {
  socket.send(encodeBinaryFrame(JSON.stringify(frame), bytes));
}

it('answers binary events on a hibernating object, before and after it is evicted', async () => {
  const { stub, socket, frames } = await open(env.BINARY_HIBERNATION_SERVER, 'binary-avatar');
  const avatar = pattern(300_000, 1);

  sendBinary(socket, ['upload-avatar', { fileType: 'image/png' }, null], avatar);
  const before = await waitFor(frames, (frame) => frame.event === 'avatar-preview');
  expect(before.payload).toEqual({ fileType: 'image/png', size: 300_000 });
  expect(hash(before.bytes!)).toBe(hash(avatar.subarray(0, 8)));

  await evictDurableObject(stub);
  frames.length = 0;

  const second = pattern(5000, 2);
  sendBinary(socket, ['upload-avatar', { fileType: 'image/jpeg' }, null], second);
  const after = await waitFor(frames, (frame) => frame.event === 'avatar-preview');
  expect(after.payload).toEqual({ fileType: 'image/jpeg', size: 5000 });
  expect(hash(after.bytes!)).toBe(hash(second.subarray(0, 8)));
});

it('replies to a binary request with bytes after the object is evicted', async () => {
  const { stub, socket, frames } = await open(env.BINARY_HIBERNATION_SERVER, 'binary-thumbnail');
  await evictDurableObject(stub);

  sendBinary(socket, ['get-thumbnail', { attachmentId: 'att_300' }, { exchange: { id: 'x1' } }]);
  const reply = await waitFor(frames, (frame) => frame.metadata?.exchange?.id === 'x1');

  expect(reply.payload).toEqual({ fileType: 'image/png' });
  expect(hash(reply.bytes!)).toBe(hash(pattern(300_000, 300).subarray(0, 4000)));
});

it('broadcasts a binary event to the other member of a room after the object is evicted', async () => {
  const sharer = await open(env.BINARY_HIBERNATION_SERVER, 'binary-room');
  const viewer = await open(env.BINARY_HIBERNATION_SERVER, 'binary-room');
  for (const member of [sharer, viewer]) {
    member.socket.send(
      JSON.stringify([
        '__subscribe__',
        null,
        { channel: { name: 'room:general', family: 'rooms' } },
      ]),
    );
    await waitFor(member.frames, (frame) => frame.event === '__subscribeOk__');
  }

  await evictDurableObject(sharer.stub);

  const picture = pattern(20_000, 3);
  sendBinary(
    sharer.socket,
    ['share-screen-frame', null, { channel: { name: 'room:general', family: 'rooms' } }],
    picture,
  );
  const received = await waitFor(viewer.frames, (frame) => frame.event === 'screen-frame');

  expect(received.payload).toEqual({ from: 'amara' });
  expect(hash(received.bytes!)).toBe(hash(picture));
});

function isExportPiece(frame: Frame): boolean {
  return frame.event === 'export-room-pdf' && frame.bytes !== undefined;
}

it('continues a recorded binary stream cut off by an abort: stored pieces, then interrupted', async () => {
  const first = await open(env.BINARY_HIBERNATION_SERVER, 'binary-export');

  sendBinary(first.socket, [
    'export-room-pdf',
    { roomId: 'room:300' },
    { stream: { id: 'pdf-1' } },
  ]);
  // The export sends a 64 KiB piece every 200 ms, so it is still running after two pieces.
  await waitFor(first.frames, (frame) => isExportPiece(frame) && frame.metadata?.stream?.seq === 2);

  // `evictDurableObject` waits for running work, so the export would finish. `abort()` stops
  // the object at once, like a crash, and drops its sockets.
  await expect(
    runInDurableObject(first.stub, (_instance, state) => state.abort('cut off the export')),
  ).rejects.toThrow('cut off the export');

  const second = await open(env.BINARY_HIBERNATION_SERVER, 'binary-export');
  second.socket.send(
    JSON.stringify(['__continueStream__', { lastKnownSeq: 0 }, { stream: { id: 'pdf-1' } }]),
  );
  const ended = await waitFor(second.frames, (frame) => frame.event === '__error__');

  expect(ended.payload).toEqual({ code: 'stream-aborted', detail: { reason: 'interrupted' } });

  const stored = second.frames.filter(isExportPiece).map((frame) => frame.bytes!);
  expect(stored.length).toBeGreaterThanOrEqual(2);
  expect(stored.length).toBeLessThan(5);

  const joined = new Uint8Array(stored.length * 64 * 1024);
  stored.forEach((bytes, index) => joined.set(bytes, index * 64 * 1024));
  expect(hash(joined)).toBe(hash(pattern(300_000, 300).subarray(0, joined.byteLength)));
});

/** Start `up-1` of `upload-attachment`, saving after every second piece. */
function startUpload(socket: WebSocket, size: number): void {
  sendBinary(socket, [
    'upload-attachment',
    { attachmentId: 'att_video', saveEvery: 2 },
    { upload: { id: 'up-1', size } },
  ]);
}

/** `seq` counts the pieces of one start, from 1. */
function sendPiece(socket: WebSocket, seq: number, bytes: Uint8Array): void {
  sendBinary(socket, ['upload-attachment', null, { upload: { id: 'up-1', seq } }], bytes);
}

it('runs an upload on a hibernating object, and resumes it after an eviction', async () => {
  const { stub, socket, frames } = await open(env.UPLOADS_HIBERNATION_SERVER, 'uploads-evicted');
  const pieces = [1, 2, 3, 4].map((seed) => pattern(PIECE, seed));
  const file = new Uint8Array(4 * PIECE);
  pieces.forEach((bytes, index) => file.set(bytes, index * PIECE));

  startUpload(socket, file.byteLength);
  await waitFor(frames, (frame) => frame.event === '__uploadAck__');
  sendPiece(socket, 1, pieces[0]!);
  sendPiece(socket, 2, pieces[1]!);
  sendPiece(socket, 3, pieces[2]!);
  // `run` saves after every second piece, so the eviction loses piece 3.
  await waitFor(
    frames,
    (frame) =>
      frame.event === '__uploadAck__' &&
      (frame.payload as { receivedThrough: number }).receivedThrough >= 3 * PIECE,
  );

  await evictDurableObject(stub);
  frames.length = 0;

  // The object woke with no running upload: the next piece hears it.
  sendPiece(socket, 4, pieces[3]!);
  const interrupted = await waitFor(frames, (frame) => frame.event === '__error__');
  expect(interrupted.payload).toEqual({
    code: 'upload-aborted',
    detail: { reason: 'interrupted' },
  });

  frames.length = 0;
  startUpload(socket, file.byteLength);
  const resumed = await waitFor(frames, (frame) => frame.event === '__uploadAck__');
  expect(resumed.payload).toMatchObject({ savedThrough: 2 * PIECE, receivedThrough: 2 * PIECE });

  sendPiece(socket, 1, pieces[2]!);
  sendPiece(socket, 2, pieces[3]!);
  socket.send(
    JSON.stringify(['__uploadEnd__', { totalBytes: file.byteLength }, { upload: { id: 'up-1' } }]),
  );

  const done = await waitFor(frames, (frame) => frame.event === '__uploadDone__');
  expect(done.payload).toEqual({
    info: {
      attachmentId: 'att_video',
      size: file.byteLength,
      hash: hash(file),
      resumedFrom: 2 * PIECE,
    },
  });
});
