import { createServer } from 'node:http';
import { server, t } from '@livething/server';
import { binary } from '@livething/server/binary';
import { channels } from '@livething/server/channels';
import { clientRequests } from '@livething/server/client-requests';
import { dedup } from '@livething/server/dedup';
import { inbox } from '@livething/server/inbox';
import { replay } from '@livething/server/replay';
import { sequence } from '@livething/server/sequence';
import { serverRequests } from '@livething/server/server-requests';
import { recordedStream, stream } from '@livething/server/streams';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { ServerDefinition } from '@livething/server';
import type { AddressInfo } from 'node:net';
import type { RawData } from 'ws';
import { setup } from './setup.ts';
import { isConnectedFrame } from './test-utils.ts';

const general = { channel: { name: 'room:general', family: 'rooms' } };
const picture = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

const MAGIC = [0x6c, 0x74, 0x62, 0x66];

/** A binary frame as any client writes it: magic, version 1, envelope length, envelope, bytes. */
function encodeFrame(envelope: string, bytes: Uint8Array): Buffer {
  const envelopeBytes = Buffer.from(envelope, 'utf8');
  const header = Buffer.alloc(9);
  header.set(MAGIC, 0);
  header[4] = 1;
  header.writeUInt32BE(envelopeBytes.byteLength, 5);

  return Buffer.concat([header, envelopeBytes, bytes]);
}

function decodeFrame(frame: Buffer): { envelope: unknown; bytes: number[] } {
  expect([...frame.subarray(0, 5)]).toEqual([...MAGIC, 1]);
  const length = frame.readUInt32BE(5);
  return {
    envelope: JSON.parse(frame.subarray(9, 9 + length).toString('utf8')),
    bytes: [...frame.subarray(9 + length)],
  };
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Received {
  data: Buffer;
  isBinary: boolean;
}

function huddle(avatars: { info: unknown; bytes: number[] }[]) {
  const base = server({
    authenticate(request) {
      return { userId: new URL(request.url).searchParams.get('user') ?? 'anonymous' };
    },
    capabilities: [binary(), channels()],
  });
  const rooms = base.channel(['rooms', 'room:{roomId}'], {
    capabilities: [binary({ emits: { 'screen-frame': t<{ from: string }>() } })],
  });
  const handleUploadAvatar = base.binary.on('upload-avatar', {
    run(_ctx, input, bytes) {
      avatars.push({ info: input, bytes: [...bytes] });
    },
  });
  const handleShareScreenFrame = rooms.binary.on('share-screen-frame', {
    run(ctx, _input, bytes) {
      ctx.channel.binary.broadcast('screen-frame', { from: ctx.user.id }, bytes);
    },
  });

  return base.assemble({ handlers: [handleUploadAvatar, handleShareScreenFrame] });
}

/** Huddle's binary requests and streams: thumbnails, attachment downloads and screen capture. */
function huddleFiles(log: string[]) {
  const base = server({
    authenticate(request) {
      return { userId: new URL(request.url).searchParams.get('user') ?? 'anonymous' };
    },
    capabilities: [
      binary({ serverRequests: { 'capture-screen': { out: t<{ maxWidth: number }>() } } }),
      clientRequests(),
      serverRequests(),
      stream(),
    ],
  });
  const handleGetThumbnail = base.binary.request('get-thumbnail', {
    run(_ctx, input) {
      log.push(`thumbnail ${(input as { attachmentId: string }).attachmentId}`);
      return { info: { fileType: 'image/png' }, bytes: picture };
    },
  });
  const handleDownloadAttachment = base.binary.stream('download-attachment', {
    async *run(ctx, rawInput) {
      const input = rawInput as { attachmentId: string; fromByte: number };
      let info: { fileName: string; fileType: string } | null = {
        fileName: 'launch-plan.pdf',
        fileType: 'application/pdf',
      };

      for (let piece = input.fromByte; piece < 3; piece += 1) {
        yield { info, bytes: new Uint8Array([piece, piece]) };
        info = null;
        await ctx.stream.drain();
      }

      if (input.attachmentId === 'att_live') {
        await new Promise((resolve) => ctx.stream.signal.addEventListener('abort', resolve));
        log.push('download cancelled');
      }
    },
  });
  const handleStartScreenShare = base.on('start-screen-share', {
    async run(ctx) {
      const { bytes } = await ctx.binary.request('capture-screen', { maxWidth: 1280 });
      log.push(`captured ${[...bytes].join(',')}`);
    },
  });

  return base.assemble({
    handlers: [handleGetThumbnail, handleDownloadAttachment, handleStartScreenShare],
  });
}

async function start(definition: ServerDefinition): Promise<number> {
  const httpServer = createServer();
  const livething = setup();
  const endpoint = livething.bind(definition, {});
  httpServer.on('upgrade', endpoint.upgrade);
  await endpoint.ready();

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => {
    await livething.shutdown();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  return (httpServer.address() as AddressInfo).port;
}

async function connect(port: number, user: string) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/huddle?user=${user}`);
  const received: Received[] = [];
  socket.on('message', (data: RawData, isBinary) => {
    if (!isConnectedFrame(data, isBinary)) received.push({ data: data as Buffer, isBinary });
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  cleanups.push(async () => {
    if (socket.readyState === WebSocket.CLOSED) return;

    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    socket.close();
    await closed;
  });

  async function until(check: () => boolean): Promise<void> {
    const started = Date.now();
    while (!check()) {
      if (Date.now() - started > 2000) throw new Error('timed out waiting for a message');

      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  return {
    socket,
    received,
    until,
    texts: () =>
      received.filter((message) => !message.isBinary).map((m) => JSON.parse(m.data.toString())),
    sendBinary: (envelope: [event: string, info: unknown, metadata: unknown], bytes = picture) =>
      socket.send(encodeFrame(JSON.stringify(envelope), bytes)),
    frames: () =>
      received.map((message) =>
        message.isBinary
          ? { kind: 'bytes', ...decodeFrame(message.data) }
          : { kind: 'text', envelope: JSON.parse(message.data.toString()) },
      ),
    subscribe: async () => {
      socket.send(JSON.stringify(['__subscribe__', {}, general]));
      await until(() => received.some((m) => !m.isBinary && m.data.includes('__subscribeOk__')));
    },
  };
}

describe('binary messages over a real ws socket', () => {
  it('reach their handler with the info and the right bytes', async () => {
    const avatars: { info: unknown; bytes: number[] }[] = [];
    const port = await start(huddle(avatars));
    const amara = await connect(port, 'u_amara');

    amara.sendBinary(['upload-avatar', { fileType: 'image/png' }, null]);
    await amara.until(() => avatars.length > 0);

    expect(avatars).toEqual([{ info: { fileType: 'image/png' }, bytes: [...picture] }]);
  });

  it('reach every other channel member as one binary frame', async () => {
    const port = await start(huddle([]));
    const amara = await connect(port, 'u_amara');
    const kofi = await connect(port, 'u_kofi');
    const ama = await connect(port, 'u_ama');
    await amara.subscribe();

    await kofi.subscribe();
    await ama.subscribe();

    amara.sendBinary(['share-screen-frame', null, general]);
    await kofi.until(() => kofi.received.some((m) => m.isBinary));
    await ama.until(() => ama.received.some((m) => m.isBinary));

    for (const member of [kofi, ama]) {
      const frames = member.received.filter((m) => m.isBinary);
      expect(frames).toHaveLength(1);
      expect(decodeFrame(frames[0]!.data)).toEqual({
        envelope: [
          'screen-frame',
          { from: 'u_amara' },
          { channel: { name: 'room:general', family: 'rooms' } },
        ],
        bytes: [...picture],
      });
    }

    expect(amara.received.filter((m) => m.isBinary)).toEqual([]);
  });

  it('answers channel-not-subscribed to a non-member', async () => {
    const port = await start(huddle([]));
    const kofi = await connect(port, 'u_kofi');

    kofi.sendBinary(['share-screen-frame', null, general]);
    await kofi.until(() => kofi.texts().some((frame) => frame[0] === '__error__'));

    expect(kofi.texts()).toEqual([
      [
        '__error__',
        { code: 'channel-not-subscribed' },
        { channel: { name: 'room:general', family: 'rooms' } },
      ],
    ]);
  });
});

describe('replay of binary messages over a real ws socket', () => {
  function huddleWithReplay() {
    const base = server({
      authenticate(request) {
        return { userId: new URL(request.url).searchParams.get('user') ?? 'anonymous' };
      },
      capabilities: [binary(), channels(), dedup(), sequence({ persist: true }), replay.history()],
    });
    const rooms = base.channel(['rooms', 'room:{roomId}'], {
      capabilities: [binary({ emits: { 'screen-frame': t<{ from: string }>() } })],
    });
    const handleShareScreenFrame = rooms.binary.on('share-screen-frame', {
      run(ctx, _input, bytes) {
        ctx.channel.binary.broadcast('screen-frame', { from: ctx.user.id }, bytes);
      },
    });

    return base.assemble({ handlers: [handleShareScreenFrame] });
  }

  it('sends a member who reconnects the screen frames it missed, as binary frames', async () => {
    const port = await start(huddleWithReplay());
    const amara = await connect(port, 'u_amara');
    const kofi = await connect(port, 'u_kofi');
    await amara.subscribe();
    await kofi.subscribe();

    const subscribed = kofi.texts().find((frame) => frame[0] === '__subscribeOk__');
    const lastKnownSeq = (subscribed[1] as { seq: number }).seq;
    kofi.socket.close();

    const frames = [new Uint8Array([1, 2, 3]), new Uint8Array(200_000).fill(9)];
    for (const bytes of frames) amara.sendBinary(['share-screen-frame', null, general], bytes);
    const kofiAgain = await connect(port, 'u_kofi');
    await kofiAgain.subscribe();
    kofiAgain.socket.send(JSON.stringify(['__replay__', { lastKnownSeq }, general]));

    await kofiAgain.until(() => kofiAgain.received.filter((m) => m.isBinary).length === 2);

    const replayed = kofiAgain.received.filter((m) => m.isBinary).map((m) => decodeFrame(m.data));
    expect(replayed.map((frame) => frame.bytes)).toEqual(frames.map((bytes) => [...bytes]));
    for (const frame of replayed) {
      expect(frame.envelope).toEqual([
        'screen-frame',
        { from: 'u_amara' },
        {
          channel: { name: 'room:general', family: 'rooms' },
          delivery: { id: expect.any(String), seq: expect.any(Number) },
        },
      ]);
    }
  });
});

describe('inbox binary messages over a real ws socket', () => {
  function huddleWithDms() {
    const base = server({
      authenticate(request) {
        return { userId: new URL(request.url).searchParams.get('user') ?? 'anonymous' };
      },
      capabilities: [binary(), channels(), dedup(), sequence({ persist: true })],
    });
    const dms = base.channel(['dms', 'dm:{pair}'], {
      membership: 'persistent',
      capabilities: [
        inbox(),
        binary({ emits: { 'voice-note': t<{ from: string; durationMs: number }>() } }),
      ],
    });
    const handleSendVoiceNote = dms.binary.on('send-voice-note', {
      run(ctx, input, bytes) {
        const { durationMs } = input as { durationMs: number };
        ctx.channel.binary.broadcast('voice-note', { from: ctx.user.id, durationMs }, bytes);
      },
    });

    return base.assemble({ handlers: [dms, handleSendVoiceNote] });
  }

  const dm = { channel: { name: 'dm:u_amara-u_kofi', family: 'dms' } };

  it('sends a member who was offline the voice note when it connects again, as one binary frame', async () => {
    const port = await start(huddleWithDms());
    const amara = await connect(port, 'u_amara');
    const kofi = await connect(port, 'u_kofi');
    for (const member of [amara, kofi]) {
      member.socket.send(JSON.stringify(['__subscribe__', {}, dm]));
      await member.until(() => member.texts().some((frame) => frame[0] === '__subscribeOk__'));
    }

    const closed = new Promise((resolve) => kofi.socket.once('close', resolve));
    kofi.socket.close();
    await closed;

    const voiceNote = new Uint8Array(300_000).fill(7);
    amara.sendBinary(['send-voice-note', { durationMs: 4200 }, dm], voiceNote);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const kofiAgain = await connect(port, 'u_kofi');
    await kofiAgain.until(() => kofiAgain.received.some((m) => m.isBinary));

    const [stored] = kofiAgain.received.filter((m) => m.isBinary).map((m) => decodeFrame(m.data));
    expect(stored!.bytes).toEqual([...voiceNote]);
    expect(stored!.envelope).toEqual([
      'voice-note',
      { from: 'u_amara', durationMs: 4200 },
      { channel: dm.channel, delivery: { id: expect.any(String), seq: expect.any(Number) } },
    ]);
  });
});

describe('recorded binary streams over a real ws socket', () => {
  function huddleWithPdfExport(release: Promise<void>) {
    const base = server({
      authenticate(request) {
        return { userId: new URL(request.url).searchParams.get('user') ?? 'anonymous' };
      },
      capabilities: [binary(), recordedStream()],
    });
    const handleExportRoomPdf = base.binary.recordedStream('export-room-pdf', {
      async *run() {
        yield { info: { fileName: 'room-design.pdf' }, bytes: new Uint8Array([1, 1]) };
        // The client drops here, and the export keeps going.
        await release;
        yield { info: null, bytes: new Uint8Array(200_000).fill(2) };
        yield { info: null, bytes: new Uint8Array([3]) };
      },
    });

    return base.assemble({ handlers: [handleExportRoomPdf] });
  }

  it('sends the chunks the client missed after a drop again, as binary frames, when it continues', async () => {
    let release!: () => void;
    const port = await start(huddleWithPdfExport(new Promise((resolve) => (release = resolve))));
    const amara = await connect(port, 'u_amara');
    amara.sendBinary(
      ['export-room-pdf', { roomId: 'room:design' }, { stream: { id: 'pdf-1' } }],
      new Uint8Array(0),
    );
    await amara.until(() => amara.received.some((m) => m.isBinary));

    const closed = new Promise((resolve) => amara.socket.once('close', resolve));
    amara.socket.close();
    await closed;
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const amaraAgain = await connect(port, 'u_amara');
    amaraAgain.socket.send(
      JSON.stringify(['__continueStream__', { lastKnownSeq: 1 }, { stream: { id: 'pdf-1' } }]),
    );
    await amaraAgain.until(() => amaraAgain.texts().some((frame) => frame[0] === '__streamEnd__'));

    const frames = amaraAgain.frames();
    expect(frames.map((frame) => frame.kind)).toEqual(['bytes', 'bytes', 'text']);
    expect(frames[0]).toEqual({
      kind: 'bytes',
      envelope: [
        'export-room-pdf',
        null,
        { stream: { id: 'pdf-1', durability: 'persistent', seq: 2 } },
      ],
      bytes: [...new Uint8Array(200_000).fill(2)],
    });
    expect(frames[1]).toMatchObject({ kind: 'bytes', bytes: [3] });
    expect(frames[2]!.envelope).toEqual([
      '__streamEnd__',
      null,
      { stream: { id: 'pdf-1', seq: 3, event: 'export-room-pdf' } },
    ]);
  });
});

describe('binary requests and streams over a real ws socket', () => {
  const NO_BYTES = new Uint8Array(0);

  it('answer a binary request with one binary frame with the same exchange', async () => {
    const log: string[] = [];
    const port = await start(huddleFiles(log));
    const amara = await connect(port, 'u_amara');
    const exchange = { exchange: { id: 'request-7', source: 'client' } };

    amara.sendBinary(['get-thumbnail', { attachmentId: 'att_1' }, exchange], NO_BYTES);
    await amara.until(() => amara.received.length > 0);

    expect(log).toEqual(['thumbnail att_1']);
    expect(amara.frames()).toEqual([
      {
        kind: 'bytes',
        envelope: ['get-thumbnail', { fileType: 'image/png' }, exchange],
        bytes: [...picture],
      },
    ]);
  });

  it('send each stream chunk as a binary frame, and end with a text frame', async () => {
    const port = await start(huddleFiles([]));
    const amara = await connect(port, 'u_amara');

    amara.sendBinary(
      [
        'download-attachment',
        { attachmentId: 'att_1', fromByte: 0 },
        { stream: { id: 'download-1' } },
      ],
      NO_BYTES,
    );
    await amara.until(() => amara.texts().some((frame) => frame[0] === '__streamEnd__'));

    function chunk(seq: number) {
      return { stream: { id: 'download-1', durability: 'ephemeral', seq } };
    }

    expect(amara.frames()).toEqual([
      {
        kind: 'text',
        envelope: ['__streamOk__', null, { stream: { id: 'download-1', durability: 'ephemeral' } }],
      },
      {
        kind: 'bytes',
        envelope: [
          'download-attachment',
          { fileName: 'launch-plan.pdf', fileType: 'application/pdf' },
          chunk(1),
        ],
        bytes: [0, 0],
      },
      { kind: 'bytes', envelope: ['download-attachment', null, chunk(2)], bytes: [1, 1] },
      { kind: 'bytes', envelope: ['download-attachment', null, chunk(3)], bytes: [2, 2] },
      {
        kind: 'text',
        envelope: ['__streamEnd__', null, { stream: { id: 'download-1', seq: 3 } }],
      },
    ]);
  });

  it('stop a binary stream when the client sends a text __streamCancel__', async () => {
    const log: string[] = [];
    const port = await start(huddleFiles(log));
    const amara = await connect(port, 'u_amara');

    amara.sendBinary(
      [
        'download-attachment',
        { attachmentId: 'att_live', fromByte: 2 },
        { stream: { id: 'download-2' } },
      ],
      NO_BYTES,
    );
    await amara.until(() => amara.received.some((message) => message.isBinary));
    amara.socket.send(JSON.stringify(['__streamCancel__', null, { stream: { id: 'download-2' } }]));
    await amara.until(() => log.length > 0);

    expect(log).toEqual(['download cancelled']);
    expect(amara.texts().map((frame) => frame[0])).toEqual(['__streamOk__']);
  });

  it('resolve ctx.binary.request with the client binary answer', async () => {
    const log: string[] = [];
    const port = await start(huddleFiles(log));
    const amara = await connect(port, 'u_amara');

    amara.socket.send(JSON.stringify(['start-screen-share', null, null]));
    await amara.until(() => amara.received.some((message) => message.isBinary));
    const request = amara.frames()[0]!;
    expect(request).toEqual({
      kind: 'bytes',
      envelope: [
        'capture-screen',
        { maxWidth: 1280 },
        { exchange: { id: expect.any(String), source: 'server' } },
      ],
      bytes: [],
    });

    const metadata = (request.envelope as unknown[])[2];
    amara.sendBinary(['capture-screen', { fileType: 'image/png' }, metadata]);
    await amara.until(() => log.length > 0);

    expect(log).toEqual([`captured ${[...picture].join(',')}`]);
  });
});
