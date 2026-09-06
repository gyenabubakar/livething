/* oxlint-disable no-unused-vars */

import { define } from '@wskit/server';
import { expectTypeOf } from 'vitest';
import * as Adapter from './index.ts';
import type { Platform } from './index.ts';

void Adapter.server;

const base = define({});
const handler = base.assemble({
  handlers: [],
  api: () => ({
    archiveRoom(room: string): Promise<number> {
      return Promise.resolve(room.length);
    },
  }),
});

const service = Adapter.server(handler, { port: 0 });
const admin = await service.admin();

expectTypeOf(admin.archiveRoom).toEqualTypeOf<(room: string) => Promise<number>>();
expectTypeOf(admin.connectionCount).toEqualTypeOf<number>();
// @ts-expect-error — the custom admin method keeps its argument type
admin.archiveRoom(42);
// @ts-expect-error — unknown admin methods are not exposed
admin.notAnAdminMethod;

declare const _platform: Platform;
void _platform;

// Internal value symbols must not be reachable from the package root.

// @ts-expect-error — createPlatform is internal
Adapter.createPlatform;
