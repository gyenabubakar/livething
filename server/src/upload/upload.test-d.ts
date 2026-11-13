/* oxlint-disable no-unused-vars */
/**
 * Compile-time checks for `base.binary.upload`: which capabilities it needs, the types of
 * `run`, `ctx.upload` and `onDiscard`, and what `InferClient` carries for it.
 */
import { plugin } from '~/_define/plugins.ts';
import { server } from '~/_define/server.ts';
import { binary } from '~/binary/capability.ts';
import { channels } from '~/channel/capability.ts';
import { rateLimit } from '~/rate-limit/capability.ts';
import { uploads } from '~/upload/capability.ts';
import * as v from 'valibot';
import { expectTypeOf } from 'vitest';
import type { InferPluginClient } from '~/_define/plugins.ts';
import type { InferClient } from '~/infer-client.ts';
import type { UploadPiece } from '~/upload/upload.ts';

const base = server({ capabilities: [binary(), channels(), uploads()] });

const handleUploadAttachment = base.binary.upload('upload-attachment', {
  input: v.object({ attachmentId: v.string() }),
  async run(ctx, input, pieces) {
    expectTypeOf(input).toEqualTypeOf<{ attachmentId: string }>();
    expectTypeOf(pieces).toEqualTypeOf<AsyncIterable<UploadPiece>>();
    expectTypeOf(ctx.upload.savedThrough).toEqualTypeOf<number>();
    expectTypeOf(ctx.upload.signal).toEqualTypeOf<AbortSignal>();
    ctx.upload.saved(0);
    // @ts-expect-error — without a `state` schema, `saved()` keeps no state.
    ctx.upload.saved(0, { state: { parts: 1 } });
    // @ts-expect-error — without a `state` schema, there is no state to read.
    ctx.upload.state;

    return { info: { size: 1 } };
  },
  onDiscard(ctx, input) {
    expectTypeOf(input).toEqualTypeOf<{ attachmentId: string }>();
    expectTypeOf(ctx.upload.savedThrough).toEqualTypeOf<number>();
    // @ts-expect-error — `onDiscard` runs with no connection, so it has no `upload.saved`.
    ctx.upload.saved(0);
    // @ts-expect-error — without a `state` schema, there is no state to read.
    ctx.upload.state;
  },
});

// With a `state` schema, `saved()` takes the schema's input and `state` is its output.
base.binary.upload('upload-attachment', {
  state: v.pipe(
    v.object({ multipartId: v.string() }),
    v.transform((state) => ({ ...state, checkedAt: 1 })),
  ),
  async run(ctx) {
    expectTypeOf(ctx.upload.state).toEqualTypeOf<
      { multipartId: string; checkedAt: number } | undefined
    >();
    ctx.upload.saved(0, { state: { multipartId: 'mp_1' } });
    // @ts-expect-error — the state must have the schema's shape.
    ctx.upload.saved(0, { state: { parts: 1 } });

    return { info: null };
  },
  onDiscard(ctx) {
    expectTypeOf(ctx.upload.state).toEqualTypeOf<
      { multipartId: string; checkedAt: number } | undefined
    >();
  },
});

// The reply must be `{ info }` and nothing else.
base.binary.upload('upload-avatar', {
  // @ts-expect-error — `byte` is not a key of a reply.
  async run() {
    return { info: null, byte: 1 };
  },
});

// A `rateLimit` on an upload needs `rateLimit()`.
const limited = server({ capabilities: [binary(), uploads(), rateLimit()] });
limited.binary.upload('upload-avatar', {
  rateLimit: { maxMessages: 5, windowMs: 60_000 },
  run: async () => ({ info: null }),
});
base.binary.upload('upload-avatar', {
  // @ts-expect-error — no `rateLimit` option without `rateLimit()`.
  rateLimit: { maxMessages: 5 },
  run: async () => ({ info: null }),
});

// `base.binary.upload` needs `uploads()`.
const withoutUploads = server({ capabilities: [binary()] });
// @ts-expect-error — no `upload` without `uploads()`.
withoutUploads.binary.upload;

// Uploads are top-level only: a channel has no `binary.upload`.
const rooms = base.channel(['rooms', 'room:{roomId}'], {});
// @ts-expect-error — a channel has no uploads.
rooms.binary.upload;

const definition = base.assemble({ handlers: [handleUploadAttachment] });
type Client = InferClient<typeof definition>;

expectTypeOf<Client['binary']['uploads']>().toEqualTypeOf<{
  'upload-attachment': { payload: { attachmentId: string }; response: { size: number } };
}>();

// A plugin's upload: its own client sees the plain name, and the host's client the
// `__<id>::` name, next to the host's own uploads.
const files = server({ scope: 'plugin', capabilities: [binary(), uploads()] });
const handleStoreFile = files.binary.upload('store-file', {
  input: v.object({ fileId: v.string() }),
  async run(ctx) {
    expectTypeOf(ctx.upload.savedThrough).toEqualTypeOf<number>();
    return { info: { stored: true } };
  },
});
const Files = plugin('acme:files', { definition: files.assemble({ handlers: [handleStoreFile] }) });

expectTypeOf<InferPluginClient<typeof Files>['binary']['uploads']>().toEqualTypeOf<{
  'store-file': { payload: { fileId: string }; response: { stored: boolean } };
}>();

const withFiles = server({ capabilities: [binary(), uploads(), Files()] });
const handleUploadAvatar = withFiles.binary.upload('upload-avatar', {
  input: v.object({ fileType: v.string() }),
  run: async () => ({ info: null }),
});
const hostDefinition = withFiles.assemble({ handlers: [handleUploadAvatar] });
type HostUploads = InferClient<typeof hostDefinition>['binary']['uploads'];

expectTypeOf<HostUploads['upload-avatar']>().toEqualTypeOf<{
  payload: { fileType: string };
  response: null;
}>();
expectTypeOf<HostUploads['__acme:files::store-file']>().toEqualTypeOf<{
  payload: { fileId: string };
  response: { stored: boolean };
}>();
