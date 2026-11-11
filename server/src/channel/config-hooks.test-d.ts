/* oxlint-disable no-unused-vars */
/** Compile-time checks for hooks written in a channel's config, and for `assemble()` handler lists. */
import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { context } from '~/ambient-context.ts';
import { channels } from '~/channel/capability.ts';
import { dedup } from '~/dedup/capability.ts';
import { emits } from '~/emits/emits.ts';
import { inbox, readReceipts } from '~/inbox/capability.ts';
import { clientRequests } from '~/request/client-requests.ts';
import { serverRequests } from '~/request/server-requests.ts';
import { scheduled } from '~/scheduled/capability.ts';
import { sequence } from '~/sequence/capability.ts';
import { recordedStream } from '~/stream-recorded/capability.ts';
import { stream } from '~/stream/capability.ts';
import * as v from 'valibot';

const base = server({
  upgrade: () => ({ userId: 'ama', meta: { role: 'admin' as string } }),
  capabilities: [
    channels(),
    clientRequests(),
    stream(),
    dedup(),
    sequence({ persist: true }),
    serverRequests({}),
  ],
});

const rooms = base.channel(['rooms', 'room:{roomId}'], {
  subscribe: v.object({ inviteToken: v.string() }),
  capabilities: [emits({ typing: t<{ from: string }>() })],
  onSubscribe(ctx) {
    ctx.channel.broadcast('typing', { from: ctx.meta.role });
    // @ts-expect-error: not a declared event
    ctx.channel.broadcast('nope', { from: 'x' });
    // @ts-expect-error: wrong payload
    ctx.channel.broadcast('typing', { from: 1 });
    // @ts-expect-error: this channel has no inbox
    void ctx.channel.inbox;
  },
  onUnsubscribe(ctx) {
    ctx.channel.broadcast('typing', { from: ctx.meta.role });
  },
  onSessionEnd(ctx) {
    ctx.channel.broadcast('typing', { from: ctx.meta.role });
  },
  intercept(ctx, frame) {
    ctx.channel.broadcast('typing', { from: frame.event });
  },
  check(ctx, input) {
    const token: string = input.inviteToken;
    ctx.channel.broadcast('typing', { from: token });
    // @ts-expect-error: not a declared event
    ctx.channel.broadcast('nope', { from: 'x' });
  },
});

const dms = base.channel(['dms', 'dm:{pair}'], {
  membership: 'persistent',
  capabilities: [
    inbox(),
    readReceipts(),
    serverRequests({
      'confirm-join': { out: t<{ room: string }>(), in: v.object({ ok: v.boolean() }) },
    }),
    emits({ message: t<{ text: string }>() }),
  ],
  async onSubscribe(ctx) {
    void ctx.channel.inbox;
    void ctx.channel.readReceipts;
    const answer = await ctx.channel.request('confirm-join', { room: 'x' });
    const ok: boolean = answer.ok;
    ctx.channel.broadcast('message', { text: String(ok) });
  },
});

// A hook can use its own channel, and one in its own function reads its types through `context`.
function joinedTeam(): void {
  const ctx = context.channelLifecycle(teams);
  ctx.channel.broadcast('joined', { from: ctx.user.id });
  // @ts-expect-error: not a declared event
  ctx.channel.broadcast('nope', { from: 'x' });
}

const teams = base.channel(['teams', 'team:{teamId}'], {
  capabilities: [emits({ joined: t<{ from: string }>() })],
  onSubscribe: joinedTeam,
  onUnsubscribe(ctx) {
    ctx.channels.get(teams.at({ teamId: 'a' })).broadcast('joined', { from: 'x' });
  },
});

// The old registration methods are gone.
// @ts-expect-error: a hook goes in the channel's config
rooms.subscribe(() => {});
// @ts-expect-error: a hook goes in the channel's config
rooms.unsubscribe(() => {});
// @ts-expect-error: a hook goes in the channel's config
rooms.sessionEnd(() => {});
// @ts-expect-error: an intercept goes in the channel's config
rooms.intercept(() => {});

const dmSend = dms.on('send-message', { input: v.object({ text: v.string() }), run() {} });
const roomSend = rooms.on('send-message', { input: v.object({ text: v.string() }), run() {} });
const roomSendAgain = rooms.on('send-message', { input: v.object({ text: v.string() }), run() {} });
const roomSendAsRequest = rooms.request('send-message', { run: () => ({ ok: true }) });
const topSend = base.on('send-message', { input: v.object({ text: v.string() }), run() {} });
const topSendAgain = base.on('send-message', { input: v.object({ text: v.string() }), run() {} });
const topRename = base.on('rename', { input: v.object({ name: v.string() }), run() {} });
const topRenameAsRequest = base.request('rename', { run: () => ({ ok: true }) });
const topRenameAsStream = base.stream('rename', {
  async *run() {
    yield { line: 'x' };
  },
});

// The same event in different scopes is fine.
export const distinct = base.assemble({ handlers: [roomSend, dmSend, topSend, topRename] });
export const withChannels = base.assemble({ handlers: [rooms, dms, roomSend] });

const roomHandlers = [roomSend, topRename] as const;
const dmHandlers = [dmSend] as const;
export const fromLists = base.assemble({ handlers: [...roomHandlers, ...dmHandlers] });
export const fromOneList = base.assemble({ handlers: roomHandlers });

// The same event in one scope is a compile error, wherever the handlers came from.
// @ts-expect-error: twice at the top level
base.assemble({ handlers: [topSend, topSendAgain] });
// @ts-expect-error: twice on one channel
base.assemble({ handlers: [roomSend, roomSendAgain] });
// @ts-expect-error: an event and a request share a name at the top level
base.assemble({ handlers: [topRename, topRenameAsRequest] });
// @ts-expect-error: an event and a stream share a name at the top level
base.assemble({ handlers: [topRename, topRenameAsStream] });
// @ts-expect-error: an event and a request share a name on a channel
base.assemble({ handlers: [roomSend, roomSendAsRequest] });
const moreRoomHandlers = [roomSendAgain] as const;
// @ts-expect-error: two lists clash
base.assemble({ handlers: [...roomHandlers, ...moreRoomHandlers] });
// @ts-expect-error: one channel handler in two lists
base.assemble({ handlers: [...roomHandlers, ...roomHandlers] });

// Recorded streams count too. A local server, because they need their own capability.
const withRecorded = server({ capabilities: [channels(), recordedStream()] });
const recordedRooms = withRecorded.channel(['recorded-rooms', 'recorded-room:{roomId}'], {});
const recordedTop = withRecorded.recordedStream('summary', {
  maxChunks: 10,
  async *run() {
    yield { line: 'x' };
  },
});
const onSummary = withRecorded.on('summary', { input: v.object({}), run() {} });
const recordedOnRoom = recordedRooms.recordedStream('summary', {
  maxChunks: 10,
  async *run() {
    yield { line: 'x' };
  },
});
const onRoomSummary = recordedRooms.on('summary', { input: v.object({}), run() {} });
export const recordedScopes = withRecorded.assemble({ handlers: [recordedTop, recordedOnRoom] });
// @ts-expect-error: an event and a recorded stream share a name at the top level
withRecorded.assemble({ handlers: [onSummary, recordedTop] });
// @ts-expect-error: a recorded stream twice at the top level
withRecorded.assemble({ handlers: [recordedTop, recordedTop] });
// @ts-expect-error: an event and a recorded stream share a name on a channel
withRecorded.assemble({ handlers: [onRoomSummary, recordedOnRoom] });

// A name that isn't one exact string can't be compared here, so the list compiles and `assemble()` checks it.
function makeTopEvent(name: string) {
  return base.on(name, { input: v.object({ text: v.string() }), run() {} });
}

function makeRoomEvent(name: string) {
  return rooms.on(name, { input: v.object({ text: v.string() }), run() {} });
}

function makeUnionEvent(name: 'join' | 'leave') {
  return base.on(name, { input: v.object({ text: v.string() }), run() {} });
}

export const fromFactories = base.assemble({
  handlers: [makeTopEvent('a'), makeTopEvent('b'), topRename],
});
export const fromRoomFactories = base.assemble({
  handlers: [makeRoomEvent('a'), makeRoomEvent('b')],
});
export const fromUnionFactory = base.assemble({
  handlers: [makeUnionEvent('join'), makeUnionEvent('leave')],
});
export const fromFactoryList = base.assemble({
  handlers: [makeTopEvent('a'), makeTopEvent('b')] as const,
});
// @ts-expect-error: two exact names still clash next to a factory
base.assemble({ handlers: [makeTopEvent('a'), topSend, topSendAgain] });

// A plain list has no known length, so only the runtime check can see inside it.
const plainRoomHandlers = [roomSend, roomSendAgain];
export function fromPlainList(): unknown {
  return base.assemble({ handlers: [...plainRoomHandlers] });
}

// Scheduled tasks are handlers too.
const withTasks = server({
  capabilities: [
    scheduled({ 'send-digest': { data: t<{ userId: string }>() }, 'expire-invites': null }),
  ],
});
const handleSendDigest = withTasks.scheduled('send-digest', {
  run(_ctx, data) {
    const userId: string = data.userId;
    void userId;
  },
});
const handleSendDigestAgain = withTasks.scheduled('send-digest', { run() {} });
const handleExpireInvites = withTasks.scheduled('expire-invites', { run() {} });

export const allTasks = withTasks.assemble({ handlers: [handleSendDigest, handleExpireInvites] });
// @ts-expect-error: not a declared task
withTasks.scheduled('nope', { run() {} });
// @ts-expect-error: the same task twice
withTasks.assemble({ handlers: [handleSendDigest, handleSendDigestAgain, handleExpireInvites] });
// @ts-expect-error: a declared task has no handler
withTasks.assemble({ handlers: [handleSendDigest] });

function makeTask(id: 'send-digest' | 'expire-invites') {
  return withTasks.scheduled(id, { run() {} });
}

export const fromTaskFactory = withTasks.assemble({
  handlers: [makeTask('send-digest'), makeTask('expire-invites')],
});
