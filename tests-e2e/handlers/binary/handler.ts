import { server, t } from '@livething/server';
import { binary } from '@livething/server/binary';
import { channels } from '@livething/server/channels';
import { clientRequests } from '@livething/server/client-requests';
import { dedup } from '@livething/server/dedup';
import { sequence } from '@livething/server/sequence';
import { serverRequests } from '@livething/server/server-requests';
import { stream } from '@livething/server/streams';
import * as v from 'valibot';
import type { InferClient } from '@livething/server';
import { pattern } from '../_shared/bytes.ts';
import { requireUsername } from '../_shared/upgrade.ts';

const base = server({
  upgrade: (request) => requireUsername(request),
  capabilities: [
    binary({
      emits: { 'avatar-preview': t<{ fileType: string; size: number }>() },
      serverRequests: {
        'capture-screen': {
          out: t<{ maxWidth: number }>(),
          in: v.object({ fileType: v.literal('image/png') }),
        },
      },
    }),
    dedup(),
    sequence(),
    channels(),
    clientRequests(),
    serverRequests(),
    stream(),
  ],
});

// A room: its members share their screens with each other (binary spec 9.1).
const rooms = base.channel(['rooms', 'room:{roomId}'], {
  capabilities: [binary({ emits: { 'screen-frame': t<{ from: string }>() } })],
});

// The preview is the first 8 bytes, so a test can check the server read the upload.
const handleUploadAvatar = base.binary.on('upload-avatar', {
  input: v.object({ fileType: v.picklist(['image/png', 'image/jpeg']) }),
  maxBytes: 2 * 1024 * 1024,
  run(ctx, input, bytes) {
    ctx.binary.send(
      'avatar-preview',
      { fileType: input.fileType, size: bytes.byteLength },
      bytes.subarray(0, 8),
    );
  },
});

const handleShareScreenFrame = rooms.binary.on('share-screen-frame', {
  input: v.null(),
  maxBytes: 1024 * 1024,
  run(ctx, _input, bytes) {
    ctx.channel.binary.broadcast('screen-frame', { from: ctx.user.id }, bytes);
  },
});

/** The attachment `att_<n>` is `pattern(<n> * 1000, <n>)`, so a test knows every byte. */
function attachment(attachmentId: string): Uint8Array {
  const n = Number(attachmentId.slice('att_'.length));
  return pattern(n * 1000, n);
}

// The thumbnail is the first 4 KB of the attachment (binary spec 9.3).
const handleGetThumbnail = base.binary.request('get-thumbnail', {
  input: v.object({ attachmentId: v.string() }),
  run(_ctx, input) {
    return {
      info: { fileType: 'image/png' as const },
      bytes: attachment(input.attachmentId).subarray(0, 4000),
    };
  },
});

// Users whose last download the client cancelled, so a test can check the cancel arrived.
const cancelledDownloads = new Set<string>();

// The attachment in 64 KiB pieces, from `fromByte` (binary spec 9.2). `att_0` never ends,
// so a test can cancel it while it runs.
const handleDownloadAttachment = base.binary.stream('download-attachment', {
  input: v.object({ attachmentId: v.string(), fromByte: v.number() }),
  chunk: t<{ fileName: string; fileType: string } | null>(),
  async *run(ctx, input) {
    cancelledDownloads.delete(ctx.user.id);
    ctx.stream.signal.addEventListener('abort', () => cancelledDownloads.add(ctx.user.id));
    let info: { fileName: string; fileType: string } | null = {
      fileName: `${input.attachmentId}.bin`,
      fileType: 'application/octet-stream',
    };

    if (input.attachmentId === 'att_0') {
      while (!ctx.stream.signal.aborted) {
        yield { info, bytes: pattern(1000, 0) };
        info = null;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      return;
    }

    const file = attachment(input.attachmentId);
    for (let start = input.fromByte; start < file.byteLength; start += 64 * 1024) {
      yield { info, bytes: file.subarray(start, start + 64 * 1024) };
      info = null;
      await ctx.stream.drain();
    }
  },
});

const handleWasDownloadCancelled = base.request('was-download-cancelled', {
  input: v.null(),
  run(ctx) {
    return { cancelled: cancelledDownloads.has(ctx.user.id) };
  },
});

// The sharer's client sends one full picture, and the room gets it as a screen frame.
const handleStartScreenShare = rooms.on('start-screen-share', {
  input: v.object({}),
  async run(ctx) {
    const { bytes } = await ctx.binary.request('capture-screen', { maxWidth: 1280 });
    ctx.channel.binary.broadcast('screen-frame', { from: ctx.user.id }, bytes);
  },
});

export const binaryDefinition = base.assemble({
  handlers: [
    handleUploadAvatar,
    rooms,
    handleShareScreenFrame,
    handleGetThumbnail,
    handleDownloadAttachment,
    handleWasDownloadCancelled,
    handleStartScreenShare,
  ],
});

export type BinaryClient = InferClient<typeof binaryDefinition>;
