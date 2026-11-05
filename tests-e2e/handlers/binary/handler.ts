import { server, t } from '@livething/server';
import { binary } from '@livething/server/binary';
import { channels } from '@livething/server/channels';
import { dedup } from '@livething/server/dedup';
import { sequence } from '@livething/server/sequence';
import * as v from 'valibot';
import type { InferClient } from '@livething/server';
import { requireUsername } from '../_shared/upgrade.ts';

const base = server({
  upgrade: (request) => requireUsername(request),
  capabilities: [
    binary({ emits: { 'avatar-preview': t<{ fileType: string; size: number }>() } }),
    dedup(),
    sequence(),
    channels(),
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

export const binaryDefinition = base.assemble({
  handlers: [handleUploadAvatar, rooms, handleShareScreenFrame],
});

export type BinaryClient = InferClient<typeof binaryDefinition>;
