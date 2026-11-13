/* oxlint-disable no-unused-vars */
/**
 * Compile-time checks for `binary.request`, `binary.stream` and `ctx.binary.request`: which
 * capabilities they need, the info types both ways, and what `InferClient` carries for them.
 */
import { t } from '~/_api/definitions.ts';
import { plugin } from '~/_define/plugins.ts';
import { server } from '~/_define/server.ts';
import { binary } from '~/binary/capability.ts';
import { channels } from '~/channel/capability.ts';
import { emits } from '~/emits/emits.ts';
import { clientRequests } from '~/request/client-requests.ts';
import { serverRequests } from '~/request/server-requests.ts';
import { stream } from '~/stream/capability.ts';
import * as v from 'valibot';
import { expectTypeOf } from 'vitest';
import type { BinaryInput } from '@livething/core';
import type { InferPluginClient } from '~/_define/plugins.ts';
import type { ConnectionRef } from '~/context.ts';
import type { InferClient } from '~/infer-client.ts';
import type { InterceptFrame } from '~/intercept/intercept.ts';
import type { ServerDefinition } from '~/server-definition.ts';

const thumbnail = new Uint8Array(4);

const base = server({
  capabilities: [
    binary({
      serverRequests: {
        'capture-screen': {
          out: t<{ maxWidth: number }>(),
          in: v.object({ fileType: v.literal('image/png') }),
        },
        'capture-camera': { out: t<null>() },
      },
    }),
    channels(),
    clientRequests(),
    serverRequests({ 'confirm-leave': { out: t<null>(), in: v.boolean() } }),
    stream(),
  ],
});

const rooms = base.channel(['rooms', 'room:{roomId}'], {
  capabilities: [
    binary({
      emits: { 'screen-frame': t<{ from: string }>() },
      serverRequests: { 'capture-whiteboard': { out: t<null>(), in: v.null() } },
    }),
  ],
});

const handleGetThumbnail = base.binary.request('get-thumbnail', {
  input: v.object({ attachmentId: v.string() }),
  maxBytes: 1024,
  run(_ctx, input, bytes) {
    expectTypeOf(input).toEqualTypeOf<{ attachmentId: string }>();
    expectTypeOf(bytes).toEqualTypeOf<Uint8Array>();
    return { info: { fileType: 'image/png' as const }, bytes: thumbnail };
  },
});

const handleGetAvatar = base.binary.request('get-avatar', {
  async run() {
    return { info: null };
  },
});

// @ts-expect-error: the reply's info must be a plain object or null
base.binary.request('get-thumbnail-size', { run: () => ({ info: 'image/png', bytes: thumbnail }) });
// @ts-expect-error: the reply's bytes must be a Uint8Array or an ArrayBuffer
base.binary.request('get-banner', { run: () => ({ info: null, bytes: 'banner' }) });
// @ts-expect-error: a typo in the reply's keys is an error, not a reply with no bytes
base.binary.request('get-banner', { run: () => ({ info: null, byte: thumbnail }) });
base.binary.request('get-banner', {
  // @ts-expect-error: the same in a function body
  run() {
    return { info: null, byte: thumbnail };
  },
});
base.binary.request('get-banner', {
  // @ts-expect-error: and in an async one
  async run() {
    return { info: null, byte: thumbnail };
  },
});
// A reply with no bytes, or with `bytes: undefined`, is fine.
base.binary.request('get-banner', { run: () => ({ info: null }) });
base.binary.request('get-banner', { run: () => ({ info: null, bytes: undefined }) });

const handleDownloadAttachment = base.binary.stream('download-attachment', {
  input: v.object({ attachmentId: v.string(), fromByte: v.number() }),
  nudges: { 'pause-download': null },
  async *run(ctx, input, bytes) {
    expectTypeOf(input).toEqualTypeOf<{ attachmentId: string; fromByte: number }>();
    expectTypeOf(bytes).toEqualTypeOf<Uint8Array>();
    expectTypeOf(ctx.stream.signal).toEqualTypeOf<AbortSignal>();
    expectTypeOf(ctx.stream.drain()).toEqualTypeOf<Promise<void>>();
    const nudges = ctx.stream.nudges(
      yield { info: { fileName: 'launch-plan.pdf', fileType: 'application/pdf' }, bytes },
    );

    expectTypeOf(nudges).toEqualTypeOf<{ event: 'pause-download'; payload: undefined }[]>();
    yield { info: null, bytes: bytes.buffer as ArrayBuffer };
  },
});

base.binary.stream('download-banner', {
  async *run(): AsyncGenerator<{ info: { fileName: string } | null; bytes: BinaryInput }> {
    // @ts-expect-error: the chunk info is { fileName } or null
    yield { info: { fileType: 'image/png' }, bytes: thumbnail };
  },
});
base.binary.stream('download-banner', {
  // @ts-expect-error: a chunk needs its bytes
  async *run() {
    yield { info: null };
  },
});

const handleGetPinnedFile = rooms.binary.request('get-pinned-file', {
  input: v.object({ pinId: v.string() }),
  run(ctx) {
    expectTypeOf(ctx.channel.name).toEqualTypeOf<string>();
    return { info: { fileName: 'notes.txt' }, bytes: new Uint8Array(1) };
  },
});

const handleDownloadRecording = rooms.binary.stream('download-recording', {
  input: v.object({ fromByte: v.number() }),
  async *run(ctx) {
    yield { info: { room: ctx.channel.params.roomId }, bytes: new Uint8Array(1) };
  },
});

const handleStartScreenShare = base.on('start-screen-share', {
  async run(ctx) {
    const answer = await ctx.binary.request('capture-screen', { maxWidth: 1280 });
    expectTypeOf(answer).toEqualTypeOf<{
      readonly info: { fileType: 'image/png' };
      readonly bytes: Uint8Array;
    }>();
    // With no `in`, the answer has no info to check.
    expectTypeOf(
      (await ctx.binary.request('capture-camera', null, thumbnail, { timeout: 5000 })).info,
    ).toEqualTypeOf<void>();
    // @ts-expect-error: 'capture-screen' sends { maxWidth }
    void ctx.binary.request('capture-screen', null);
    // @ts-expect-error: 'confirm-leave' is a JSON server request
    void ctx.binary.request('confirm-leave', null);
    // @ts-expect-error: 'capture-screen' is a binary server request
    void ctx.request('capture-screen', { maxWidth: 1280 });
    // @ts-expect-error: the bytes must be a Uint8Array or an ArrayBuffer
    void ctx.binary.request('capture-camera', null, 'bytes');

    const fromKofi = await ctx.users
      .get('u_kofi')
      .binary.request('capture-screen', { maxWidth: 640 });
    expectTypeOf(fromKofi.info).toEqualTypeOf<{ fileType: 'image/png' }>();
    expectTypeOf(fromKofi.from).toEqualTypeOf<ConnectionRef>();
    expectTypeOf(
      (await ctx.connections.get(ctx.connection).binary.request('capture-camera', null)).bytes,
    ).toEqualTypeOf<Uint8Array>();

    // The senders are still there.
    expectTypeOf(ctx.binary.send).toBeFunction();
  },
});

const handleShareWhiteboard = rooms.on('share-whiteboard', {
  async run(ctx) {
    const answer = await ctx.channel.binary.request('capture-whiteboard', null, undefined, {
      to: ctx.connection,
    });
    expectTypeOf(answer.info).toEqualTypeOf<null>();
    ctx.channel.binary.broadcast('screen-frame', { from: ctx.user.id }, answer.bytes);
    // @ts-expect-error: 'capture-screen' belongs to the root, not to the channel
    void ctx.channel.binary.request('capture-screen', { maxWidth: 1 });
  },
});

const huddle = base.assemble({
  handlers: [
    handleGetThumbnail,
    handleGetAvatar,
    handleDownloadAttachment,
    handleGetPinnedFile,
    handleDownloadRecording,
    handleStartScreenShare,
    handleShareWhiteboard,
  ],
});

type HuddleClient = InferClient<typeof huddle>;

// ctx.matches and ctx.unsafeCast narrow to the info of binary requests and streams too.
type HuddleCtx =
  typeof huddle extends ServerDefinition<infer _Primitives, infer _Contract, infer TCtx>
    ? TCtx
    : never;
declare const huddleCtx: HuddleCtx;
declare const frame: InterceptFrame;
expectTypeOf(huddleCtx.unsafeCast('get-thumbnail', frame).payload).toEqualTypeOf<{
  attachmentId: string;
}>();
if (huddleCtx.matches('download-attachment', frame)) {
  expectTypeOf(frame.payload).toEqualTypeOf<{ attachmentId: string; fromByte: number }>();
}

expectTypeOf(huddleCtx.unsafeCast('@rooms::get-pinned-file', frame).payload).toEqualTypeOf<{
  pinId: string;
}>();
expectTypeOf(huddleCtx.unsafeCast('@rooms::download-recording', frame).payload).toEqualTypeOf<{
  fromByte: number;
}>();

expectTypeOf<HuddleClient['binary']>().toEqualTypeOf<{
  incoming: {};
  outgoing: {};
  clientRequests: {
    'get-thumbnail': { payload: { attachmentId: string }; response: { fileType: 'image/png' } };
    'get-avatar': { payload: unknown; response: null };
  };
  serverRequests: {
    'capture-screen': { payload: { maxWidth: number }; response: { fileType: 'image/png' } };
    'capture-camera': { payload: null; response: void };
  };
  streams: {
    'download-attachment': {
      payload: { attachmentId: string; fromByte: number };
      chunk: { fileName: string; fileType: string } | null;
      nudges: { 'pause-download': undefined };
      kind: 'ephemeral';
    };
  };
}>();
expectTypeOf<HuddleClient['channels']['rooms']['binary']>().toEqualTypeOf<{
  incoming: { 'screen-frame': { from: string } };
  outgoing: {};
  clientRequests: {
    'get-pinned-file': { payload: { pinId: string }; response: { fileName: string } };
  };
  serverRequests: { 'capture-whiteboard': { payload: null; response: null } };
  streams: {
    'download-recording': {
      payload: { fromByte: number };
      chunk: { room: string };
      kind: 'ephemeral';
    };
  };
}>();
// The binary handlers stay out of the JSON maps.
expectTypeOf<HuddleClient['clientRequests']>().toEqualTypeOf<{}>();
expectTypeOf<HuddleClient['streams']>().toEqualTypeOf<{}>();
expectTypeOf<HuddleClient['serverRequests']>().toEqualTypeOf<{
  'confirm-leave': { payload: null; response: boolean };
}>();
expectTypeOf<HuddleClient['channels']['rooms']['serverRequests']>().toEqualTypeOf<{}>();

// A channel with binary server requests and no binary events has nothing to broadcast.
const huddles = base.channel(['huddles', 'huddle:{huddleId}'], {
  capabilities: [binary({ serverRequests: { 'capture-whiteboard': { out: t<null>() } } })],
});
huddles.on('share-whiteboard', {
  run(ctx) {
    void ctx.channel.binary.request('capture-whiteboard', null);
    // @ts-expect-error: this channel declares no binary events
    ctx.channel.binary.broadcast('screen-frame', null);
    // @ts-expect-error: this channel declares no binary events
    ctx.channel.binary.send('any-name', null);
  },
});
// A channel with a plain binary() declares no binary events either.
const lounges = base.channel('lounge', { capabilities: [binary()] });
lounges.on('share-photo', {
  run(ctx) {
    // @ts-expect-error: this channel declares no binary events
    ctx.channel.binary.broadcast('screen-frame', null);
  },
});
const huddlesOnly = base.assemble({ handlers: [huddles, lounges] });
expectTypeOf<
  InferClient<typeof huddlesOnly>['channels']['huddles']['binary']['incoming']
>().toEqualTypeOf<{}>();

// Each one needs its JSON version's capability.
const eventsOnly = server({ capabilities: [binary(), channels()] });
// @ts-expect-error: base.binary.request needs clientRequests()
eventsOnly.binary.request('get-thumbnail', { run: () => ({ info: null }) });
// @ts-expect-error: base.binary.stream needs stream()
eventsOnly.binary.stream('download-attachment', { async *run() {} });
const lobby = eventsOnly.channel('lobby', {});
// @ts-expect-error: a channel's binary.request needs clientRequests()
lobby.binary.request('get-pinned-file', { run: () => ({ info: null }) });
// @ts-expect-error: a channel's binary.stream needs stream()
lobby.binary.stream('download-recording', { async *run() {} });

// Without binary server requests, `.binary` has no `request`. (A root `binary({ serverRequests })`
// without `serverRequests()` is caught by `assemble()`, which throws.)
const noBinaryRequests = server({ capabilities: [binary(), serverRequests({})] });
noBinaryRequests.on('start-screen-share', {
  run(ctx) {
    ctx.binary.send;
    // @ts-expect-error: nothing is declared in binary({ serverRequests })
    void ctx.binary.request('capture-screen', null);
  },
});
// Connectionless code sends no server requests.
base.assemble({
  handlers: [],
  api: (ctx) => {
    // @ts-expect-error: a connectionless connection handle has no binary.request
    void ctx.connections.get({} as ConnectionRef).binary.request('capture-screen', { maxWidth: 1 });
    // @ts-expect-error: nor does a connectionless user handle
    void ctx.users.get('u_kofi').binary.request('capture-screen', { maxWidth: 1 });
    ctx.users.get('u_kofi').binary.broadcast;
    return {};
  },
});

const noBinary = server({ capabilities: [serverRequests({}), clientRequests(), stream()] });
noBinary.on('start-screen-share', {
  run(ctx) {
    // @ts-expect-error: ctx.binary needs binary()
    void ctx.binary.request('capture-screen', null);
  },
});
// @ts-expect-error: base.binary needs binary()
noBinary.binary.request('get-thumbnail', { run: () => ({ info: null }) });

// A channel's binary server requests need serverRequests() at the root.
const noRootRequests = server({ capabilities: [binary(), channels()] });
// @ts-expect-error: binary({ serverRequests }) in a channel needs serverRequests() at the root
noRootRequests.channel('lobby', {
  capabilities: [binary({ serverRequests: { 'capture-whiteboard': { out: t<null>() } } })],
});

// A plugin's binary requests, streams and server requests: plain names in InferPluginClient,
// `__<id>::` names in the host's InferClient.
const files = server({
  scope: 'plugin',
  capabilities: [
    binary({ serverRequests: { 'capture-screen': { out: t<null>(), in: v.null() } } }),
    clientRequests(),
    serverRequests(),
    stream(),
  ],
});
const handleGetFile = files.binary.request('get-file', { run: () => ({ info: null }) });
const handleDownloadFile = files.binary.stream('download-file', {
  async *run() {
    yield { info: null, bytes: new Uint8Array(1) };
  },
});
const Files = plugin('acme:files', {
  definition: files.assemble({ handlers: [handleGetFile, handleDownloadFile] }),
});

type FilesClient = InferPluginClient<typeof Files>['binary'];
expectTypeOf<FilesClient['clientRequests']>().toEqualTypeOf<{
  'get-file': { payload: unknown; response: null };
}>();
expectTypeOf<FilesClient['serverRequests']>().toEqualTypeOf<{
  'capture-screen': { payload: null; response: null };
}>();
expectTypeOf<FilesClient['streams']['download-file']['chunk']>().toEqualTypeOf<null>();
expectTypeOf<FilesClient['streams']['download-file']['kind']>().toEqualTypeOf<'ephemeral'>();

const filesHost = server({ capabilities: [Files()] }).assemble({ handlers: [] });
expectTypeOf<InferClient<typeof filesHost>['binary']>().toEqualTypeOf<{
  incoming: {};
  outgoing: {};
  clientRequests: { '__acme:files::get-file': { payload: unknown; response: null } };
  serverRequests: { '__acme:files::capture-screen': { payload: null; response: null } };
  streams: {
    '__acme:files::download-file': { payload: unknown; chunk: null; kind: 'ephemeral' };
  };
}>();

// A client contract has a `binary` key only when some scope has binary entries.
const emitsOnly = server({ capabilities: [emits({ 'avatar-saved': t<{ userId: string }>() })] });
const emitsOnlyDefinition = emitsOnly.assemble({ handlers: [] });
expectTypeOf<
  'binary' extends keyof InferClient<typeof emitsOnlyDefinition> ? 1 : 0
>().toEqualTypeOf<0>();
const jsonPolls = server({ scope: 'plugin', capabilities: [clientRequests()] });
const Polls = plugin('acme:polls', {
  definition: jsonPolls.assemble({
    handlers: [jsonPolls.request('vote', { run: () => ({ ok: true }) })],
  }),
});
const withJsonPlugin = server({ capabilities: [Polls()] }).assemble({ handlers: [] });
expectTypeOf<
  'binary' extends keyof InferClient<typeof withJsonPlugin> ? 1 : 0
>().toEqualTypeOf<0>();
expectTypeOf<'binary' extends keyof HuddleClient ? 1 : 0>().toEqualTypeOf<1>();

// A channel with empty serverRequests({}) and binary server requests has no JSON request to send.
const studios = base.channel(['studios', 'studio:{studioId}'], {
  capabilities: [
    serverRequests({}),
    binary({ serverRequests: { 'capture-whiteboard': { out: t<null>() } } }),
  ],
});
studios.on('share-whiteboard', {
  run(ctx) {
    void ctx.channel.binary.request('capture-whiteboard', null);
    // @ts-expect-error: the channel declares no JSON server requests
    ctx.channel.request;
  },
});

// One name is one handler in a scope, across JSON and binary.
base.assemble({
  // @ts-expect-error: 'get-thumbnail' is bound twice
  handlers: [handleGetThumbnail, base.request('get-thumbnail', { run: () => null })],
});
