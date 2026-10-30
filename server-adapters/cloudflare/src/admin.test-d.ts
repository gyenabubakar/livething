/**
 * Compile-time fixture: what a Worker's `stub.admin()` accepts, typed from the
 * server definition through Workers RPC's own stub types.
 */

import { emits, server, t } from '@livething/server';
import { channels } from '@livething/server/channels';
import { expectTypeOf } from 'vitest';
import { bind } from './index.ts';
import type { CloudflareAdmin } from './index.ts';

const huddleBase = server({
  upgrade: () => ({ userId: 'user_9', meta: { displayName: 'Ada' } }),
  capabilities: [emits({ announcement: t<{ text: string }>() }), channels()],
});
const general = huddleBase.channel('general', {
  capabilities: [emits({ huddleClosing: t<{ reason: string }>() })],
});
const rooms = huddleBase.channel(['rooms', 'room:{roomId}'], {
  capabilities: [emits({ message: t<{ text: string }>() })],
});
const huddle = huddleBase.assemble({
  handlers: [general, rooms],
  api: (ctx) => ({
    onlineCount(): number {
      return ctx.connectionCount;
    },
  }),
});

class HuddleServer extends bind(huddle) {}

declare const stub: DurableObjectStub<HuddleServer>;

// Pipelined calls, with no await between the levels.
await stub.admin().users.get('user_9').broadcast('announcement', { text: 'your export is ready' });
// @ts-expect-error — not an event this definition emits
await stub.admin().users.get('user_9').broadcast('announcementTypo', { text: 'x' });
// @ts-expect-error — wrong payload for a declared event
await stub.admin().users.get('user_9').broadcast('announcement', { text: 42 });

const admin = await stub.admin();
await admin.broadcast('announcement', { text: 'maintenance in 5m' });
// @ts-expect-error — not an event this definition emits
await admin.broadcast('maintenance', { text: 'x' });
// @ts-expect-error — wrong payload for a declared event
await admin.broadcast('announcement', { body: 'x' });

expectTypeOf(await admin.connectionCount).toEqualTypeOf<number>();
const [first] = await admin.connections.all();
if (first) {
  expectTypeOf(first.meta.displayName).toEqualTypeOf<string>();
  await admin.connections.get(await first.ref()).send('announcement', { text: 'hello' });
  // @ts-expect-error — not an event this definition emits
  await admin.connections.get(await first.ref()).send('hello', {});
}

// lastSeen() is a method, so it crosses the stub as a callable stub, like ref().
if (first?.lastSeen) {
  expectTypeOf(await first.lastSeen()).toEqualTypeOf<number | null>();
}

const ada = await admin.users.get('user_9').info();
if (ada?.lastSeen) {
  expectTypeOf(await ada.lastSeen()).toEqualTypeOf<number | null>();
}

expectTypeOf(await admin.users.get('user_9').isOnline()).toEqualTypeOf<boolean>();
expectTypeOf(await stub.admin().users.get('user_9').isOnline()).toEqualTypeOf<boolean>();

await admin.channels.broadcast('general', 'huddleClosing', { reason: 'maintenance' });
await stub.admin().channels.broadcast('general', 'huddleClosing', { reason: 'maintenance' });
await admin.channels.broadcast({ family: 'rooms', name: 'room:42' }, 'message', { text: 'hi' });
// @ts-expect-error — an event of another channel, not of general
await admin.channels.broadcast('general', 'message', { text: 'hi' });
// @ts-expect-error — no channel declares this event
await admin.channels.broadcast('general', 'huddleOpened', {});
// @ts-expect-error — wrong payload for general's event
await admin.channels.broadcast('general', 'huddleClosing', { reason: 42 });
// @ts-expect-error — not a channel this definition declares
await admin.channels.broadcast('random', 'huddleClosing', { reason: 'x' });
// @ts-expect-error — a family is named with { family, name }, not its key alone
await admin.channels.broadcast('rooms', 'message', { text: 'hi' });
// @ts-expect-error — general is a static channel, not a family
await admin.channels.broadcast({ family: 'general', name: 'x' }, 'huddleClosing', { reason: 'x' });
// @ts-expect-error — an event of general, not of rooms
await admin.channels.broadcast({ family: 'rooms', name: 'room:42' }, 'huddleClosing', {
  reason: 'x',
});
// @ts-expect-error — the channel handle does not broadcast; use channels.broadcast
admin.channels.get('general').broadcast;
expectTypeOf(await admin.channels.get('general').members()).toBeArray();
// @ts-expect-error — not a channel this definition declares
admin.channels.get('random');

await admin.closeConnections({ userId: 'user_9' }, 4001, 'session revoked');
await admin.purgeUser('user_9', { keepBroadcastContent: true });
expectTypeOf(await admin.onlineCount()).toEqualTypeOf<number>();

// Storage and scheduling stay inside the Durable Object.
// @ts-expect-error — not on the stub
admin.sql;
// @ts-expect-error — not on the stub
admin.schedule;

// Without channels(), the admin surface has no `channels`.
const plain = server({ capabilities: [emits({ announcement: t<{ text: string }>() })] }).assemble({
  handlers: [],
});
declare const plainAdmin: CloudflareAdmin<typeof plain>;
// @ts-expect-error — channels() is not listed
plainAdmin.channels;

// The "Reaching it" docs example, against a definition with a static channel and a family.
const docsBase = server({
  capabilities: [emits({ announcement: t<{ text: string }>() }), channels()],
});
const docsGeneral = docsBase.channel('general', {
  capabilities: [emits({ announcement: t<{ text: string }>() })],
});
const docsRooms = docsBase.channel(['rooms', 'room:{roomId}'], {
  capabilities: [emits({ announcement: t<{ text: string }>() })],
});
const docsDefinition = docsBase.assemble({ handlers: [docsGeneral, docsRooms] });
class DocsServer extends bind(docsDefinition) {}

declare const docsStub: DurableObjectStub<DocsServer>;

await docsStub
  .admin()
  .users.get('user_9')
  .broadcast('announcement', { text: 'your export is ready' });
const docsAdmin = await docsStub.admin();
expectTypeOf(await docsAdmin.connectionCount).toEqualTypeOf<number>();
await docsAdmin.channels.broadcast('general', 'announcement', { text: 'maintenance in 5m' });
await docsAdmin.channels.get('general').kick(await docsAdmin.users.get('user_9').ref(), {
  reason: 'removed by a moderator',
});
await docsAdmin.channels.broadcast({ family: 'rooms', name: 'room:42' }, 'announcement', {
  text: 'closing',
});
for (const info of await docsAdmin.connections.all()) {
  if (info.quality === 'poor') {
    await docsAdmin.connections.get(await info.ref()).close(4000, 'slow connection');
  }
}
