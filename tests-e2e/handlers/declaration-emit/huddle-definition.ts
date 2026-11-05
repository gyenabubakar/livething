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
  async upgrade(request) {
    return { userId: request.url, meta: { name: 'a', role: 'admin' as string } };
  },
  capabilities: [
    emits({ notification: t<{ title: string }>() }),
    errors([NotFound]),
    binary({ emits: { 'avatar-preview': t<null>() } }),
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
    binary({ emits: { 'screen-frame': t<{ from: string }>() } }),
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
  chunk: t<{ line: string }>(),
  async *run() {
    yield { line: 'x' };
  },
});
export const handleRecorded = rooms.recordedStream('summary', {
  chunk: t<{ line: string }>(),
  maxChunks: 10,
  async *run() {
    yield { line: 'x' };
  },
});
export const handleTop = base.on('top', { input: v.object({ text: v.string() }), run() {} });
export const handleTopAsk = base.request('top-ask', { run: () => ({ ok: true }) });
export const handleTopFeed = base.stream('top-feed', {
  chunk: t<{ line: string }>(),
  async *run() {
    yield { line: 'x' };
  },
});
export const handleTopRecorded = base.recordedStream('top-summary', {
  chunk: t<{ line: string }>(),
  maxChunks: 10,
  async *run() {
    yield { line: 'x' };
  },
});
export const handleDigest = base.scheduled('send-digest', { run() {} });
export const handleUploadAvatar = base.binary.on('upload-avatar', {
  input: v.object({ fileType: v.string() }),
  run(ctx, _input, bytes) {
    ctx.binary.send('avatar-preview', null, bytes);
  },
});
export const handleShareScreenFrame = rooms.binary.on('share-screen-frame', {
  run(ctx, _input, bytes) {
    ctx.channel.binary.broadcast('screen-frame', { from: ctx.user.id }, bytes);
  },
});

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
] as const;

export const definition = base.assemble({ handlers });
