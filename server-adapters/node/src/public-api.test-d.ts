/* oxlint-disable no-unused-vars */

import { server } from '@wskit/server';
import { expectTypeOf } from 'vitest';
import * as Adapter from './index.ts';
import type { NodeWebSocketServer, Platform } from './index.ts';

void Adapter.setup;

const base = server({});
const definition = base.assemble({
  handlers: [],
  api: () => ({
    archiveRoom(room: string): Promise<number> {
      return Promise.resolve(room.length);
    },
  }),
});

const wskit = Adapter.setup();
const endpoint = wskit.bind(definition, {});
const admin = await endpoint.admin();
const upgrade = endpoint.upgrade;
await wskit.ready();
void upgrade;

expectTypeOf(admin.archiveRoom).toEqualTypeOf<(room: string) => Promise<number>>();
expectTypeOf(admin.connectionCount).toEqualTypeOf<number>();
// @ts-expect-error — the custom admin method keeps its argument type
admin.archiveRoom(42);
// @ts-expect-error — unknown admin methods are not exposed
admin.notAnAdminMethod;

declare const _platform: Platform;
declare const _webSocketServer: NodeWebSocketServer;
void _platform;
void _webSocketServer;

// Internal value symbols must not be reachable from the package root.

// @ts-expect-error — createPlatform is internal
Adapter.createPlatform;
