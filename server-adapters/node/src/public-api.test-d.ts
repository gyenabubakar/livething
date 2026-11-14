/* oxlint-disable no-unused-vars */

import { DatabaseSync } from 'node:sqlite';
import { emits, server, t } from '@livething/server';
import { channels } from '@livething/server/channels';
import { expectTypeOf } from 'vitest';
import * as Adapter from './index.ts';
import type { NodeWebSocketServer, Platform } from './index.ts';

void Adapter.setup;

const base = server({ capabilities: [emits({ announcement: t<{ text: string }>() })] });
const definition = base.assemble({
  handlers: [],
  api: () => ({
    archiveRoom(room: string): Promise<number> {
      return Promise.resolve(room.length);
    },
  }),
});

const livething = Adapter.setup();
const endpoint = livething.bind(definition, {});
// `sql` takes a node:sqlite database too, for Node 22.16+ and Deno.
livething.bind(definition, { sql: new DatabaseSync(':memory:') });
const admin = await endpoint.admin();
const upgrade = endpoint.upgrade;
await livething.ready();
void upgrade;

expectTypeOf(admin.archiveRoom).toEqualTypeOf<(room: string) => Promise<number>>();
expectTypeOf(admin.connectionCount).toEqualTypeOf<number>();
// @ts-expect-error — the custom admin method keeps its argument type
admin.archiveRoom(42);
// @ts-expect-error — unknown admin methods are not exposed
admin.notAnAdminMethod;

// Built-in admin operations are typed against the definition's own emits.
admin.broadcast('announcement', { text: 'maintenance in 5m' });
admin.users.get('user_9').broadcast('announcement', { text: 'your export is ready' });
expectTypeOf(admin.users.get('user_9').isOnline()).toEqualTypeOf<boolean>();
// @ts-expect-error — not an event this definition emits
admin.users.get('user_9').broadcast('announcementTypo', { text: 'x' });
// @ts-expect-error — wrong payload for a declared event
admin.broadcast('announcement', { text: 42 });

const huddleBase = server({ capabilities: [channels()] });
const general = huddleBase.channel('general', {
  capabilities: [emits({ huddleClosing: t<{ reason: string }>() })],
});
const rooms = huddleBase.channel(['rooms', 'room:{roomId}'], {
  capabilities: [emits({ message: t<{ text: string }>() })],
});
const huddle = huddleBase.assemble({ handlers: [general, rooms] });
const huddleAdmin = await livething.bind(huddle, {}).admin();

expectTypeOf(
  huddleAdmin.channels.broadcast('general', 'huddleClosing', { reason: 'maintenance' }),
).toEqualTypeOf<void>();
huddleAdmin.channels.broadcast({ family: 'rooms', name: 'room:42' }, 'message', { text: 'hi' });
huddleAdmin.channels.get('general').broadcast('huddleClosing', { reason: 'maintenance' });
// @ts-expect-error — an event of another channel, not of general
huddleAdmin.channels.broadcast('general', 'message', { text: 'hi' });
// @ts-expect-error — wrong payload for general's event
huddleAdmin.channels.broadcast('general', 'huddleClosing', { reason: 42 });
// @ts-expect-error — not a channel this definition declares
huddleAdmin.channels.broadcast('random', 'huddleClosing', { reason: 'x' });
// @ts-expect-error — a family is named with { family, name }, not its key alone
huddleAdmin.channels.broadcast('rooms', 'message', { text: 'hi' });
// @ts-expect-error — an event of general, not of rooms
huddleAdmin.channels.broadcast({ family: 'rooms', name: 'room:42' }, 'huddleClosing', {
  reason: 'x',
});

declare const _platform: Platform;
declare const _webSocketServer: NodeWebSocketServer;
void _platform;
void _webSocketServer;

// Internal value symbols must not be reachable from the package root.

// @ts-expect-error — createPlatform is internal
Adapter.createPlatform;
