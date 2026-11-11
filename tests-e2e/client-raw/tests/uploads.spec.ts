import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { hash, pattern } from '../../handlers/_shared/bytes.ts';
import {
  closeSocket,
  connect,
  frames,
  installRig,
  send,
  sendBinary,
  waitForFrame,
} from './_ws-rig.ts';
import type { WireFrame } from './_ws-rig.ts';

// Uploads over the raw wire (binary spec Part 12), against the `uploads` server definition:
// 64 KiB pieces, a 256 KiB window and a 4 MiB limit. Each piece is `pattern(size, seed)`, so
// the spec knows the hash of the whole file.
const KiB = 1024;
const PIECE = 64 * KiB;

/** The whole file a list of pieces makes: its size and its hash. */
function fileOf(pieces: { size: number; seed: number }[]): { size: number; hash: string } {
  const file = new Uint8Array(pieces.reduce((total, piece) => total + piece.size, 0));
  let at = 0;
  for (const piece of pieces) {
    file.set(pattern(piece.size, piece.seed), at);
    at += piece.size;
  }

  return { size: file.byteLength, hash: hash(file) };
}

interface Socket {
  page: Page;
  id: string;
}

async function open(page: Page, room: string, options: { username?: string; path?: string } = {}) {
  await page.goto('/');
  await installRig(page);
  const id = await connect(page, {
    path: options.path ?? '/ws/uploads',
    username: options.username ?? 'amara',
    room,
  });
  return { page, id };
}

async function reconnect(socket: Socket, room: string, options: { path?: string } = {}) {
  const id = await connect(socket.page, {
    path: options.path ?? '/ws/uploads',
    username: 'amara',
    room,
  });
  return { page: socket.page, id };
}

/** Every test's upload has this id. */
const UPLOAD_ID = 'up-1';

function start(socket: Socket, input: object, size?: number) {
  return sendBinary(socket.page, socket.id, {
    event: 'upload-attachment',
    payload: input as Record<string, unknown>,
    metadata: { upload: { id: UPLOAD_ID, ...(size === undefined ? {} : { size }) } },
  });
}

function piece(socket: Socket, seq: number, bytes: { size: number; seed: number }) {
  return sendBinary(socket.page, socket.id, {
    event: 'upload-attachment',
    payload: null,
    metadata: { upload: { id: UPLOAD_ID, seq } },
    bytes,
  });
}

function end(socket: Socket, uploadId: string, totalBytes: number) {
  return send(socket.page, socket.id, {
    event: '__uploadEnd__',
    payload: { totalBytes },
    metadata: { upload: { id: uploadId } },
  });
}

function cancel(socket: Socket, uploadId: string) {
  return send(socket.page, socket.id, {
    event: '__uploadCancel__',
    payload: null,
    metadata: { upload: { id: uploadId } },
  });
}

function upload(uploadId: string) {
  return (frame: WireFrame) => frame.metadata?.upload?.id === uploadId;
}

function waitFor(socket: Socket, match: (frame: WireFrame) => boolean, timeoutMs?: number) {
  return waitForFrame(socket.page, socket.id, { match, timeoutMs });
}

/** Wait for a frame that arrives after the socket's first `after` frames. */
async function waitForNew(
  socket: Socket,
  after: number,
  match: (frame: WireFrame) => boolean,
): Promise<WireFrame> {
  let hit: WireFrame | undefined;
  await expect
    .poll(async () => {
      hit = (await frames(socket.page, socket.id)).slice(after).find(match);
      return hit !== undefined;
    })
    .toBe(true);
  return hit!;
}

async function frameCount(socket: Socket): Promise<number> {
  return (await frames(socket.page, socket.id)).length;
}

/** Wait until `run` has read `bytes` bytes of the upload. */
function waitForRead(socket: Socket, uploadId: string, bytes: number) {
  return waitFor(
    socket,
    (frame) =>
      upload(uploadId)(frame) &&
      frame.event === '__uploadAck__' &&
      Number(frame.payload.receivedThrough) >= bytes,
  );
}

function waitForError(socket: Socket, uploadId: string) {
  return waitFor(socket, (frame) => upload(uploadId)(frame) && frame.event === '__error__');
}

let requests = 0;
async function request(socket: Socket, event: string, payload: Record<string, unknown>) {
  requests += 1;
  const id = `r${requests}`;
  await send(socket.page, socket.id, { event, payload, metadata: { exchange: { id } } });
  const reply = await waitFor(socket, (frame) => frame.metadata?.exchange?.id === id);

  return reply.payload;
}

const fourPieces = [1, 2, 3, 4].map((seed) => ({ size: PIECE, seed }));

/**
 * Send pieces from seq 1, waiting for acks so the 256 KiB window is never full. `from` is the
 * offset the upload starts at: the saved offset of a resume.
 */
async function sendPieces(
  socket: Socket,
  uploadId: string,
  { pieces, from = 0 }: { pieces: { size: number; seed: number }[]; from?: number },
) {
  let sent = from;
  for (const [index, bytes] of pieces.entries()) {
    if (sent + bytes.size - from > 4 * PIECE) {
      await waitForRead(socket, uploadId, sent + bytes.size - 4 * PIECE);
    }

    await piece(socket, index + 1, bytes);
    sent += bytes.size;
  }
}

test.describe('uploads (raw wire)', () => {
  test('sends a file in pieces: acks each one, replies with the info, and the bytes are stored', async ({
    page,
  }, testInfo) => {
    const room = `upl-flow-${testInfo.testId}`;
    const amara = await open(page, room);
    const pieces = [
      { size: PIECE, seed: 1 },
      { size: PIECE, seed: 2 },
      { size: 10 * KiB, seed: 3 },
    ];
    const file = fileOf(pieces);

    await start(amara, { attachmentId: 'att_deck' }, file.size);
    const first = await waitFor(
      amara,
      (frame) => upload('up-1')(frame) && frame.event === '__uploadAck__',
    );
    expect(first.payload).toEqual({
      receivedThrough: 0,
      savedThrough: 0,
      pieceBytes: PIECE,
      windowBytes: 4 * PIECE,
    });

    await sendPieces(amara, 'up-1', { pieces });
    await end(amara, 'up-1', file.size);
    const done = await waitFor(
      amara,
      (frame) => upload('up-1')(frame) && frame.event === '__uploadDone__',
    );
    expect(done.payload).toEqual({
      info: { attachmentId: 'att_deck', size: file.size, hash: file.hash, resumedFrom: 0 },
    });

    const acks = (await frames(page, amara.id)).filter(
      (frame) => upload('up-1')(frame) && frame.event === '__uploadAck__',
    );
    expect(acks.map((ack) => ack.payload.receivedThrough)).toEqual([
      0,
      PIECE,
      2 * PIECE,
      file.size,
    ]);
    expect(await request(amara, 'get-attachment', { attachmentId: 'att_deck' })).toEqual(file);
  });

  for (const restart of [false, true]) {
    test(`resumes from the last save after the socket drops${restart ? ' and the server restarts' : ''}`, async ({
      page,
    }, testInfo) => {
      const room = `upl-resume-${restart}-${testInfo.testId}`;
      const input = { attachmentId: 'att_video', saveEvery: 2, slowMs: 300 };
      const file = fileOf(fourPieces);
      const first = await open(page, room);
      await start(first, input, file.size);

      await sendPieces(first, 'up-1', { pieces: fourPieces });
      // Three pieces read, two saved: the third is lost with the drop.
      await waitForRead(first, 'up-1', 3 * PIECE);
      await closeSocket(page, first.id);
      // The Node test server shuts a room down 1 s after its last socket closes.
      if (restart) await page.waitForTimeout(1500);

      const second = await reconnect(first, room);
      await start(second, input, file.size);
      const ack = await waitFor(
        second,
        (frame) => upload('up-1')(frame) && frame.event === '__uploadAck__',
      );
      expect(ack.payload).toEqual({
        receivedThrough: 2 * PIECE,
        savedThrough: 2 * PIECE,
        pieceBytes: PIECE,
        windowBytes: 4 * PIECE,
      });

      await sendPieces(second, 'up-1', { pieces: fourPieces.slice(2), from: 2 * PIECE });
      await end(second, 'up-1', file.size);
      const done = await waitFor(
        second,
        (frame) => upload('up-1')(frame) && frame.event === '__uploadDone__',
      );
      expect(done.payload).toEqual({
        info: {
          attachmentId: 'att_video',
          size: file.size,
          hash: file.hash,
          resumedFrom: 2 * PIECE,
        },
      });
    });
  }

  test('answers a new start of a done upload with the stored reply, without running it again', async ({
    page,
  }, testInfo) => {
    const room = `upl-done-${testInfo.testId}`;
    const file = fileOf([{ size: PIECE, seed: 7 }]);
    const first = await open(page, room);
    await start(first, { attachmentId: 'att_logo' });
    await piece(first, 1, { size: PIECE, seed: 7 });

    await end(first, 'up-1', PIECE);
    const done = await waitFor(
      first,
      (frame) => upload('up-1')(frame) && frame.event === '__uploadDone__',
    );
    await closeSocket(page, first.id);

    // The reply was lost: the client starts the upload again.
    const second = await reconnect(first, room);
    await start(second, { attachmentId: 'att_logo' });
    const again = await waitFor(
      second,
      (frame) => upload('up-1')(frame) && frame.event === '__uploadDone__',
    );
    expect(again.payload).toEqual(done.payload);
    expect(again.payload).toEqual({
      info: { attachmentId: 'att_logo', size: PIECE, hash: file.hash, resumedFrom: 0 },
    });

    expect((await frames(page, second.id)).filter(upload('up-1'))).toHaveLength(1);
  });

  test('cancel stops the upload, runs onDiscard with what was saved, and a new start begins at 0', async ({
    page,
  }, testInfo) => {
    const room = `upl-cancel-${testInfo.testId}`;
    const input = { attachmentId: 'att_draft', slowMs: 200 };
    const amara = await open(page, room);
    await start(amara, input);
    await sendPieces(amara, 'up-1', { pieces: fourPieces });

    await waitForRead(amara, 'up-1', PIECE);
    await cancel(amara, 'up-1');

    await expect
      .poll(async () => (await request(amara, 'list-discarded', {})).discarded)
      .toEqual([
        { attachmentId: 'att_draft', savedThrough: expect.any(Number), state: expect.anything() },
      ]);
    expect(await request(amara, 'get-attachment', { attachmentId: 'att_draft' })).toEqual({
      size: 0,
      hash: hash(new Uint8Array(0)),
    });

    const after = await frameCount(amara);
    await start(amara, input);
    const ack = await waitForNew(
      amara,
      after,
      (frame) => upload('up-1')(frame) && frame.event === '__uploadAck__',
    );
    expect(ack.payload).toMatchObject({ savedThrough: 0, pieceBytes: PIECE });
  });

  test('when run throws, the client gets that error, and onDiscard runs', async ({
    page,
  }, testInfo) => {
    const room = `upl-throw-${testInfo.testId}`;
    const amara = await open(page, room);
    await start(amara, { attachmentId: 'att_full', failAt: 2 });
    await sendPieces(amara, 'up-1', { pieces: fourPieces.slice(0, 2) });

    const error = await waitForError(amara, 'up-1');
    expect(error.payload).toEqual({ code: 'storage-full' });
    await expect
      .poll(async () => (await request(amara, 'list-discarded', {})).discarded)
      .toEqual([{ attachmentId: 'att_full', savedThrough: PIECE, state: { parts: 1 } }]);
  });

  const failures: [string, (socket: Socket) => Promise<void>, string, object?][] = [
    ['a piece with the wrong seq', (s) => piece(s, 2, { size: PIECE, seed: 1 }), 'bad-piece'],
    ['a piece over pieceBytes', (s) => piece(s, 1, { size: PIECE + 1, seed: 1 }), 'bad-piece'],
    [
      'a text piece',
      (s) =>
        send(s.page, s.id, {
          event: 'upload-attachment',
          payload: null,
          metadata: { upload: { id: 'up-1', seq: 1 } },
        }),
      'bad-piece',
    ],
    [
      'more bytes than the window allows',
      async (s) => {
        for (let seq = 1; seq <= 6; seq += 1) await piece(s, seq, { size: PIECE, seed: seq });
      },
      'window',
      { slowMs: 1000 },
    ],
    ['an end total over maxBytes', (s) => end(s, 'up-1', 4 * 1024 * KiB + 1), 'too-large'],
    [
      'an end total below the bytes sent',
      async (s) => {
        await piece(s, 1, { size: PIECE, seed: 1 });
        await end(s, 'up-1', 10);
      },
      'bad-piece',
      { slowMs: 1000 },
    ],
  ];

  for (const [name, act, reason, extra] of failures) {
    test(`fails the upload on ${name}, and discards it`, async ({ page }, testInfo) => {
      const room = `upl-fail-${reason}-${testInfo.testId}`;
      const amara = await open(page, room);
      await start(amara, { attachmentId: 'att_bad', ...extra });
      await waitFor(amara, (frame) => upload('up-1')(frame) && frame.event === '__uploadAck__');
      await act(amara);

      const error = await waitForError(amara, 'up-1');
      expect(error.payload).toEqual({ code: 'upload-aborted', detail: { reason } });
      await expect
        .poll(async () => (await request(amara, 'list-discarded', {})).discarded)
        .toHaveLength(1);
    });
  }

  test('refuses a start whose size is over maxBytes, before any piece', async ({
    page,
  }, testInfo) => {
    const amara = await open(page, `upl-big-${testInfo.testId}`);
    await start(amara, { attachmentId: 'att_big' }, 4 * 1024 * KiB + 1);
    const error = await waitForError(amara, 'up-1');
    expect(error.payload).toEqual({ code: 'upload-aborted', detail: { reason: 'too-large' } });
    expect((await frames(page, amara.id)).filter(upload('up-1'))).toHaveLength(1);
  });

  test('refuses an end total that differs from the start size', async ({ page }, testInfo) => {
    const amara = await open(page, `upl-size-${testInfo.testId}`);
    await start(amara, { attachmentId: 'att_size' }, PIECE);
    await piece(amara, 1, { size: PIECE, seed: 1 });
    await end(amara, 'up-1', PIECE - 1);
    const error = await waitForError(amara, 'up-1');

    expect(error.payload).toEqual({ code: 'upload-aborted', detail: { reason: 'bad-piece' } });
  });

  test('refuses a resume with another input', async ({ page }, testInfo) => {
    const room = `upl-input-${testInfo.testId}`;
    const first = await open(page, room);
    await start(first, { attachmentId: 'att_a' });
    await waitFor(first, (frame) => upload('up-1')(frame) && frame.event === '__uploadAck__');
    await closeSocket(page, first.id);

    const second = await reconnect(first, room);
    await start(second, { attachmentId: 'att_b' });
    const error = await waitForError(second, 'up-1');
    expect(error.payload).toEqual({ code: 'upload-aborted', detail: { reason: 'input-mismatch' } });
  });

  test('refuses an anonymous connection', async ({ page }, testInfo) => {
    const anonymous = await open(page, `upl-anon-${testInfo.testId}`, { username: '' });
    await start(anonymous, { attachmentId: 'att_anon' });
    const error = await waitForError(anonymous, 'up-1');
    expect(error.payload).toEqual({ code: 'durable-stream-requires-user' });
  });

  test('a second connection takes the upload over: the first hears it, and its late pieces are dropped', async ({
    page,
  }, testInfo) => {
    const room = `upl-takeover-${testInfo.testId}`;
    const input = { attachmentId: 'att_tabs', slowMs: 200 };
    const file = fileOf(fourPieces);
    const first = await open(page, room);
    await start(first, input, file.size);

    await sendPieces(first, 'up-1', { pieces: fourPieces.slice(0, 2) });
    await waitForRead(first, 'up-1', 2 * PIECE);

    const second = await reconnect(first, room);
    await start(second, input, file.size);
    const error = await waitForError(first, 'up-1');
    expect(error.payload).toEqual({ code: 'upload-aborted', detail: { reason: 'taken-over' } });
    const ack = await waitFor(
      second,
      (frame) => upload('up-1')(frame) && frame.event === '__uploadAck__',
    );

    const resumeAt = Number(ack.payload.savedThrough);
    expect([PIECE, 2 * PIECE]).toContain(resumeAt);

    // A late piece from the first connection does not reach the new run.
    await piece(first, 3, { size: PIECE, seed: 99 });
    const rest = fourPieces.slice(resumeAt / PIECE);
    await sendPieces(second, 'up-1', { pieces: rest, from: resumeAt });
    await end(second, 'up-1', file.size);
    const done = await waitFor(
      second,
      (frame) => upload('up-1')(frame) && frame.event === '__uploadDone__',
    );

    expect(done.payload).toMatchObject({ info: { size: file.size, hash: file.hash } });
  });

  test('a piece for an upload the server is not running is answered once with interrupted', async ({
    page,
  }, testInfo) => {
    const amara = await open(page, `upl-interrupted-${testInfo.testId}`);
    await piece(amara, 1, { size: PIECE, seed: 1 });
    await piece(amara, 2, { size: PIECE, seed: 2 });
    await end(amara, 'up-1', 2 * PIECE);

    const error = await waitForError(amara, 'up-1');
    expect(error.payload).toEqual({ code: 'upload-aborted', detail: { reason: 'interrupted' } });
    await page.waitForTimeout(300);
    expect((await frames(page, amara.id)).filter(upload('up-1'))).toHaveLength(1);
  });

  test("an upload's rateLimit refuses a third start in its window, and does not count pieces", async ({
    page,
  }, testInfo) => {
    const amara = await open(page, `upl-rate-${testInfo.testId}`);
    const caption = {
      caption: 'Just an example',
      photos: [{ photoId: 'photo_1', size: PIECE * 5 }],
    };

    for (const id of ['photos-1', 'photos-2', 'photos-3']) {
      await sendBinary(page, amara.id, {
        event: 'upload-photos',
        payload: caption,
        metadata: { upload: { id } },
      });
    }

    const refused = await waitForError({ page, id: amara.id }, 'photos-3');
    expect(refused.payload).toMatchObject({ code: 'rate-limited' });

    // Five pieces of the first upload, more than the limit of 2, all go through.
    for (let seq = 1; seq <= 5; seq += 1) {
      await sendBinary(page, amara.id, {
        event: 'upload-photos',
        payload: null,
        metadata: { upload: { id: 'photos-1', seq } },
        bytes: { size: PIECE, seed: seq },
      });
      await waitFor(
        amara,
        (frame) =>
          upload('photos-1')(frame) &&
          frame.event === '__uploadAck__' &&
          Number(frame.payload.receivedThrough) >= seq * PIECE,
      );
    }

    await end(amara, 'photos-1', PIECE * 5);
    const done = await waitFor(
      amara,
      (frame) => upload('photos-1')(frame) && frame.event === '__uploadDone__',
    );
    expect(done.payload).toMatchObject({ info: { caption: 'Just an example' } });
  });

  test("a plugin's upload runs under its __<id>:: name, and its error keeps the plugin code", async ({
    page,
  }, testInfo) => {
    const amara = await open(page, `upl-plugin-${testInfo.testId}`);
    const event = '__acme:files::store-file';
    const pieces = [
      { size: PIECE, seed: 1 },
      { size: 10 * KiB, seed: 2 },
    ];
    const file = fileOf(pieces);
    await sendBinary(page, amara.id, {
      event,
      payload: { fileId: 'f1' },
      metadata: { upload: { id: 'file-1', size: file.size } },
    });

    for (const [index, bytes] of pieces.entries()) {
      await sendBinary(page, amara.id, {
        event,
        payload: null,
        metadata: { upload: { id: 'file-1', seq: index + 1 } },
        bytes,
      });
    }

    await end(amara, 'file-1', file.size);
    const done = await waitFor(
      amara,
      (frame) => upload('file-1')(frame) && frame.event === '__uploadDone__',
    );
    expect(done.payload).toEqual({ info: { fileId: 'f1', ...file } });

    await sendBinary(page, amara.id, {
      event,
      payload: { fileId: 'f2', full: true },
      metadata: { upload: { id: 'file-2' } },
    });
    await sendBinary(page, amara.id, {
      event,
      payload: null,
      metadata: { upload: { id: 'file-2', seq: 1 } },
      bytes: { size: PIECE, seed: 3 },
    });
    const error = await waitForError(amara, 'file-2');
    expect(error.payload).toEqual({ code: '__acme:files::files-full' });

    // The bare name is not the plugin's upload.
    await sendBinary(page, amara.id, {
      event: 'store-file',
      payload: { fileId: 'f3' },
      metadata: { upload: { id: 'file-3' } },
    });
    await page.waitForTimeout(300);
    expect((await frames(page, amara.id)).filter(upload('file-3'))).toEqual([]);
  });

  test('a server without uploads answers __uploadEnd__ with unsupported-protocol', async ({
    page,
  }, testInfo) => {
    const amara = await open(page, `upl-none-${testInfo.testId}`, { path: '/ws/binary' });
    await end(amara, 'up-1', 10);
    const error = await waitForError(amara, 'up-1');
    expect(error.payload).toEqual({
      code: 'unsupported-protocol',
      detail: { event: '__uploadEnd__' },
    });
  });

  test('an idle upload expires: onDiscard runs, and a new start begins at 0', async ({
    page,
  }, testInfo) => {
    const room = `upl-expire-${testInfo.testId}`;
    const path = '/ws/uploads-expiry';
    const first = await open(page, room, { path });
    await start(first, { attachmentId: 'att_old' });
    await piece(first, 1, { size: PIECE, seed: 1 });

    await waitForRead(first, 'up-1', PIECE);
    await closeSocket(page, first.id);
    await page.waitForTimeout(3000);

    const second = await reconnect(first, room, { path });
    await expect
      .poll(async () => (await request(second, 'list-discarded', {})).discarded, {
        timeout: 10_000,
      })
      .toEqual([{ attachmentId: 'att_old', savedThrough: PIECE, state: { parts: 1 } }]);
    await start(second, { attachmentId: 'att_old' });
    const ack = await waitFor(
      second,
      (frame) => upload('up-1')(frame) && frame.event === '__uploadAck__',
    );
    expect(ack.payload.savedThrough).toBe(0);
  });

  test('a running upload does not expire, however long it runs', async ({ page }, testInfo) => {
    const room = `upl-long-${testInfo.testId}`;
    const amara = await open(page, room, { path: '/ws/uploads-expiry' });
    const file = fileOf(fourPieces);
    // Four pieces at 600 ms each run for longer than the 1.5 s expiry.
    await start(amara, { attachmentId: 'att_long', slowMs: 600 }, file.size);
    await sendPieces(amara, 'up-1', { pieces: fourPieces });
    await end(amara, 'up-1', file.size);
    const done = await waitFor(
      amara,
      (frame) => upload('up-1')(frame) && frame.event === '__uploadDone__',
      20_000,
    );
    expect(done.payload).toMatchObject({ info: { hash: file.hash } });

    expect((await request(amara, 'list-discarded', {})).discarded).toEqual([]);
  });

  test('keeps a done reply only for retentionAfterDoneMs', async ({ page }, testInfo) => {
    const room = `upl-retention-${testInfo.testId}`;
    const amara = await open(page, room, { path: '/ws/uploads-expiry' });
    await start(amara, { attachmentId: 'att_once' });
    await piece(amara, 1, { size: PIECE, seed: 1 });
    await end(amara, 'up-1', PIECE);

    await waitFor(amara, (frame) => upload('up-1')(frame) && frame.event === '__uploadDone__');
    await page.waitForTimeout(3000);

    // The stored reply is gone, so the same id is a new upload.
    const after = await frameCount(amara);
    await start(amara, { attachmentId: 'att_once' });
    const next = await waitForNew(amara, after, upload('up-1'));
    expect(next.event).toBe('__uploadAck__');
    expect(next.payload).toMatchObject({ savedThrough: 0, pieceBytes: PIECE });
  });
});
