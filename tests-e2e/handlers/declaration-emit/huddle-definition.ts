// Compiled with `declaration: true` through the package's public exports. If an inferred
// type here needs a type the package doesn't export, the typecheck fails with TS2883 or TS4023.
import { context, emits, errors, server, t } from '@livething/server';
import { binary } from '@livething/server/binary';
import { channels } from '@livething/server/channels';
import { clientRequests } from '@livething/server/client-requests';
import { dedup } from '@livething/server/dedup';
import { error } from '@livething/server/errors';
import { inbox, readReceipts } from '@livething/server/inbox';
import { keepalive } from '@livething/server/keepalive';
import { lastSeen } from '@livething/server/last-seen';
import { plugin } from '@livething/server/plugins';
import { replay } from '@livething/server/replay';
import { scheduled } from '@livething/server/scheduled';
import { sequence } from '@livething/server/sequence';
import { serverRequests } from '@livething/server/server-requests';
import { recordedStream, stream } from '@livething/server/streams';
import { tags } from '@livething/server/tags';
import * as v from 'valibot';

export const NotFound = error('not-found', v.object({ id: v.string() }));

const polls = server({
  scope: 'plugin',
  capabilities: [channels(), clientRequests(), scheduled({ 'close-poll': null })],
});
export const handlePing = polls.on('ping', { input: v.object({}), run() {} });
export const handleClosePoll = polls.scheduled('close-poll', { run() {} });
export const pollsDefinition = polls.assemble({ handlers: [handlePing, handleClosePoll] });
export const Polls = plugin('acme:polls', { definition: pollsDefinition });

export const base = server({
  async authenticate(request) {
    return { userId: request.url, meta: { name: 'a', role: 'admin' as string } };
  },
  capabilities: [
    emits({ notification: t<{ title: string }>() }),
    errors([NotFound]),
    binary({
      emits: { 'avatar-preview': t<null>() },
      serverRequests: {
        'capture-screen': {
          out: t<{ maxWidth: number }>(),
          in: v.object({ fileType: v.literal('image/png') }),
        },
      },
    }),
    channels(),
    keepalive(),
    scheduled({ 'send-digest': { data: t<{ userId: string }>() } }),
    tags((ephemeral) => [ephemeral('team', t<string>())]),
    clientRequests(),
    serverRequests({
      'confirm-delete': { out: t<{ preview: string }>(), in: v.object({ confirmed: v.boolean() }) },
    }),
    stream(),
    recordedStream(),
    dedup(),
    sequence({ persist: true }),
    replay.history(),
    lastSeen(),
  ],
});

export const rooms = base.channel(['rooms', 'room:{roomId}'], {
  subscribe: v.object({ inviteToken: v.string() }),
  capabilities: [
    emits({ typing: t<{ from: string }>() }),
    binary({
      emits: { 'screen-frame': t<{ from: string }>() },
      serverRequests: { 'capture-whiteboard': { out: t<null>(), in: v.null() } },
    }),
  ],
  onSubscribe(ctx) {
    ctx.channel.broadcast('typing', { from: ctx.user.id });
  },
});

export const dms = base.channel(['dms', 'dm:{pair}'], {
  membership: 'persistent',
  capabilities: [inbox(), readReceipts(), emits({ message: t<{ text: string }>() })],
});

export const announcements = base.channel('announcements', {
  capabilities: [emits({ announcement: t<{ text: string }>() })],
});

export const handleSend = rooms.on('send', { input: v.object({ text: v.string() }), run() {} });
export const handleAsk = rooms.request('ask', { run: () => ({ ok: true }) });
export const handleFeed = rooms.stream('feed', {
  async *run() {
    yield { line: 'x' };
  },
});
export const handleRecorded = rooms.recordedStream('summary', {
  maxChunks: 10,
  async *run() {
    yield { line: 'x' };
  },
});
export const handleTop = base.on('top', { input: v.object({ text: v.string() }), run() {} });
export const handleTopAsk = base.request('top-ask', { run: () => ({ ok: true }) });
export const handleTopFeed = base.stream('top-feed', {
  async *run() {
    yield { line: 'x' };
  },
});
export const handleTopRecorded = base.recordedStream('top-summary', {
  maxChunks: 10,
  async *run() {
    yield { line: 'x' };
  },
});
export const handleDigest = base.scheduled('send-digest', { run() {} });
export const handleUploadAvatar = base.binary.on('upload-avatar', {
  input: v.object({ fileType: v.string() }),
  run(ctx, _input, bytes) {
    ctx.binary.send('avatar-preview', bytes, { info: null });
  },
});
export const handleShareScreenFrame = rooms.binary.on('share-screen-frame', {
  run(ctx, _input, bytes) {
    ctx.channel.binary.broadcast('screen-frame', bytes, { info: { from: ctx.user.id } });
  },
});

export const handleGetThumbnail = base.binary.request('get-thumbnail', {
  input: v.object({ attachmentId: v.string() }),
  run: () => ({ info: { fileType: 'image/png' }, bytes: new Uint8Array(1) }),
});
export const handleDownloadAttachment = base.binary.stream('download-attachment', {
  async *run(ctx): AsyncGenerator<{ info: { fileName: string } | null; bytes: Uint8Array }> {
    yield { info: null, bytes: new Uint8Array(1) };
    await ctx.stream.drain();
  },
});
export const handleStartScreenShare = rooms.on('start-screen-share', {
  async run(ctx) {
    const { bytes } = await ctx.binary.request('capture-screen', undefined, {
      info: { maxWidth: 1280 },
    });
    await ctx.channel.binary.request('capture-whiteboard', undefined, { info: null });
    ctx.channel.binary.broadcast('screen-frame', bytes, { info: { from: ctx.user.id } });
  },
});
export const handleGetPinnedFile = rooms.binary.request('get-pinned-file', {
  run: () => ({ info: null }),
});
export const handleDownloadRecording = rooms.binary.stream('download-recording', {
  async *run() {
    yield { info: { part: 1 }, bytes: new Uint8Array(1) };
  },
});

const files = server({
  scope: 'plugin',
  capabilities: [
    binary({ serverRequests: { 'capture-camera': { out: t<null>(), in: v.null() } } }),
    channels(),
    clientRequests(),
    serverRequests(),
    stream(),
  ],
});
const stage = files.channel('stage', {});
export const handleGetFile = files.binary.request('get-file', { run: () => ({ info: null }) });
export const handleDownloadFile = files.binary.stream('download-file', {
  async *run() {
    yield { info: null, bytes: new Uint8Array(1) };
  },
});
export const handleGetStageFile = stage.binary.request('get-stage-file', {
  run: () => ({ info: null }),
});
export const handleCaptureCamera = files.on('capture-camera-now', {
  async run(ctx) {
    await ctx.binary.request('capture-camera', undefined, { info: null });
  },
});
export const filesDefinition = files.assemble({
  handlers: [handleGetFile, handleDownloadFile, stage, handleGetStageFile, handleCaptureCamera],
});
export const Files = plugin('acme:files', { definition: filesDefinition });

export function currentContext() {
  return context.connection(base);
}

export const handlers = [
  rooms,
  dms,
  announcements,
  handleSend,
  handleAsk,
  handleFeed,
  handleRecorded,
  handleTop,
  handleTopAsk,
  handleTopFeed,
  handleTopRecorded,
  handleDigest,
  handleUploadAvatar,
  handleShareScreenFrame,
  handleGetThumbnail,
  handleDownloadAttachment,
  handleStartScreenShare,
  handleGetPinnedFile,
  handleDownloadRecording,
] as const;

export const definition = base.assemble({ handlers });
