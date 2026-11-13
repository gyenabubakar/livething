import { errors, server } from '@livething/server';
import { binary } from '@livething/server/binary';
import { clientRequests } from '@livething/server/client-requests';
import { Disconnect, error } from '@livething/server/errors';
import { plugin } from '@livething/server/plugins';
import { rateLimit } from '@livething/server/rate-limit';
import { uploads } from '@livething/server/uploads';
import * as v from 'valibot';
import type { InferClient } from '@livething/server';
import type { InferPluginClient } from '@livething/server/plugins';
import type { UploadsOptions } from '@livething/server/uploads';
import { allowAnonymous } from '../_shared/authenticate.ts';
import { hash } from '../_shared/bytes.ts';

/** `run` throws this when the test asks the disk to fill up. */
export const StorageFull = error('storage-full');

const KiB = 1024;

interface Sql {
  exec<TRow = Record<string, unknown>>(query: string, ...params: unknown[]): { toArray(): TRow[] };
}

function ensureTables(sql: Sql): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS attachment_pieces (
    attachment_id TEXT NOT NULL,
    offset INTEGER NOT NULL,
    bytes BLOB NOT NULL,
    PRIMARY KEY (attachment_id, offset)
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS discard_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    attachment_id TEXT NOT NULL,
    saved_through INTEGER NOT NULL,
    state TEXT
  )`);
}

/** The stored bytes of one attachment, in order. */
function storedFile(sql: Sql, attachmentId: string): Uint8Array {
  const rows = sql
    .exec<{
      bytes: ArrayBuffer | Uint8Array;
    }>('SELECT bytes FROM attachment_pieces WHERE attachment_id = ? ORDER BY offset', attachmentId)
    .toArray();
  const pieces = rows.map((row) => new Uint8Array(row.bytes));
  const file = new Uint8Array(pieces.reduce((total, piece) => total + piece.byteLength, 0));
  let at = 0;
  for (const piece of pieces) {
    file.set(piece, at);
    at += piece.byteLength;
  }

  return file;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const AttachmentInput = v.object({
  attachmentId: v.string(),
  /** Call `ctx.upload.saved()` after this many pieces, like a multipart upload. Default: 1. */
  saveEvery: v.optional(v.number()),
  /** Throw `StorageFull` after reading this many pieces in one run. */
  failAt: v.optional(v.number()),
  /** Wait this long after each piece, so a test can act while the upload runs. */
  slowMs: v.optional(v.number()),
});

const PhotosInput = v.object({
  caption: v.string(),
  photos: v.array(v.object({ photoId: v.string(), size: v.number() })),
});

/** A plugin's own error, which reaches the client as `__acme:files::files-full`. */
const FilesFull = error('files-full');

// A plugin with its own upload: it lists `uploads()` and shares the host's upload engine.
const files = server({
  scope: 'plugin',
  capabilities: [binary(), uploads(), errors([FilesFull])],
});
const handleStoreFile = files.binary.upload('store-file', {
  input: v.object({ fileId: v.string(), full: v.optional(v.boolean()) }),
  pieceBytes: 64 * KiB,
  windowBytes: 256 * KiB,
  async run(_ctx, input, pieces) {
    const parts: Uint8Array[] = [];
    for await (const { bytes } of pieces) {
      if (input.full) throw FilesFull();

      parts.push(bytes.slice());
    }

    const file = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
    let at = 0;
    for (const part of parts) {
      file.set(part, at);
      at += part.byteLength;
    }

    return { info: { fileId: input.fileId, size: file.byteLength, hash: hash(file) } };
  },
});

/** The `acme:files` plugin: one upload, `store-file`. */
export const FilesPlugin = plugin('acme:files', {
  definition: files.assemble({ handlers: [handleStoreFile] }),
});

/** The plugin's client contract, for its client half. */
export type FilesWire = InferPluginClient<typeof FilesPlugin>;

function defineUploads(options: UploadsOptions, { hibernation = false } = {}) {
  const base = server({
    hibernation,
    authenticate: (request) => allowAnonymous(request),
    capabilities: [
      binary(),
      uploads(options),
      clientRequests(),
      errors([StorageFull]),
      // High enough that only `upload-photos`' own limit is ever reached.
      rateLimit({ maxMessages: 10_000 }),
      FilesPlugin(),
    ],
  });

  // One attachment, saved in parts: the pieces since the last save are lost on a drop, so a
  // resume starts again at the last save.
  const handleUploadAttachment = base.binary.upload('upload-attachment', {
    input: AttachmentInput,
    state: v.object({ parts: v.number() }),
    maxBytes: 4 * 1024 * KiB,
    pieceBytes: 64 * KiB,
    windowBytes: 256 * KiB,
    async run(ctx, input, pieces) {
      ensureTables(ctx.sql);
      const resumedFrom = ctx.upload.savedThrough;
      ctx.sql.exec(
        'DELETE FROM attachment_pieces WHERE attachment_id = ? AND offset >= ?',
        input.attachmentId,
        resumedFrom,
      );
      const saveEvery = input.saveEvery ?? 1;
      let read = 0;

      let size = resumedFrom;
      for await (const piece of pieces) {
        read += 1;
        if (input.failAt !== undefined && read >= input.failAt) throw StorageFull();

        ctx.sql.exec(
          'INSERT OR REPLACE INTO attachment_pieces (attachment_id, offset, bytes) VALUES (?, ?, ?)',
          input.attachmentId,
          piece.offset,
          piece.bytes,
        );
        size = piece.offset + piece.bytes.byteLength;
        if (read % saveEvery === 0) ctx.upload.saved(size, { state: { parts: read } });
        if (input.slowMs) await sleep(input.slowMs);
      }

      ctx.upload.saved(size);
      const file = storedFile(ctx.sql, input.attachmentId);

      return {
        info: {
          attachmentId: input.attachmentId,
          size: file.byteLength,
          hash: hash(file),
          resumedFrom,
        },
      };
    },
    onDiscard(ctx, input) {
      ensureTables(ctx.sql);
      ctx.sql.exec('DELETE FROM attachment_pieces WHERE attachment_id = ?', input.attachmentId);
      ctx.sql.exec(
        'INSERT INTO discard_log (attachment_id, saved_through, state) VALUES (?, ?, ?)',
        input.attachmentId,
        ctx.upload.savedThrough,
        JSON.stringify(ctx.upload.state ?? null),
      );
    },
  });

  // Several photos with one caption, joined into one upload: `run` cuts them apart by size.
  // At most two photo posts start per minute; the pieces are not counted.
  const handleUploadPhotos = base.binary.upload('upload-photos', {
    input: PhotosInput,
    maxBytes: 4 * 1024 * KiB,
    pieceBytes: 64 * KiB,
    rateLimit: { maxMessages: 2, windowMs: 60_000 },
    async run(_ctx, input, pieces) {
      const files = input.photos.map((photo) => ({ ...photo, bytes: new Uint8Array(photo.size) }));
      let index = 0;
      let at = 0;
      for await (const { bytes } of pieces) {
        let rest = bytes;
        while (rest.byteLength > 0 && index < files.length) {
          const file = files[index]!;
          const take = Math.min(rest.byteLength, file.size - at);
          file.bytes.set(rest.subarray(0, take), at);
          at += take;
          rest = rest.subarray(take);

          if (at === file.size) {
            index += 1;
            at = 0;
          }
        }
      }

      return {
        info: {
          caption: input.caption,
          photos: files.map((file) => ({
            photoId: file.photoId,
            size: file.size,
            hash: hash(file.bytes),
          })),
        },
      };
    },
  });

  const handleGetAttachment = base.request('get-attachment', {
    input: v.object({ attachmentId: v.string() }),
    run(ctx, input) {
      ensureTables(ctx.sql);
      const file = storedFile(ctx.sql, input.attachmentId);
      return { size: file.byteLength, hash: hash(file) };
    },
  });

  const handleListDiscarded = base.request('list-discarded', {
    input: v.object({}),
    run(ctx) {
      ensureTables(ctx.sql);
      const rows = ctx.sql
        .exec<{
          attachment_id: string;
          saved_through: number;
          state: string | null;
        }>('SELECT attachment_id, saved_through, state FROM discard_log ORDER BY id')
        .toArray();
      return {
        discarded: rows.map((row) => ({
          attachmentId: row.attachment_id,
          savedThrough: Number(row.saved_through),
          state: row.state === null ? null : (JSON.parse(row.state) as unknown),
        })),
      };
    },
  });

  // The server closes this connection, so the client's upload sees a drop.
  const handleServerDrop = base.on('server-drop', {
    input: v.object({}),
    run() {
      throw Disconnect(4500, 'test drop');
    },
  });

  return base.assemble({
    handlers: [
      handleUploadAttachment,
      handleUploadPhotos,
      handleGetAttachment,
      handleListDiscarded,
      handleServerDrop,
    ],
  });
}

export const uploadsDefinition = defineUploads({});

/** The same handlers, with short times, for the expiry and the done-retention specs. */
export const uploadsExpiryDefinition = defineUploads({
  expireAfterMs: 1500,
  retentionAfterDoneMs: 1500,
});

/** The same handlers on a hibernating Durable Object (Cloudflare only). */
export const uploadsHibernationDefinition = defineUploads({}, { hibernation: true });

export type UploadsClient = InferClient<typeof uploadsDefinition>;
