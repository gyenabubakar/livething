import { server } from '@livething/server';
import { expectTypeOf } from 'vitest';
import { bind } from './index.ts';
import type { CloudflareAdmin } from './index.ts';

const huddleBase = server({
  authenticate: () => ({ userId: 'user_9', meta: { displayName: 'Ada' } }),
  capabilities: [],
});
const huddle = huddleBase.assemble({
  handlers: [],
  api: (ctx) => ({
    onlineCount(): number {
      return ctx.connectionCount;
    },
    retentionDays: 30,
  }),
});

class HuddleServer extends bind(huddle) {}

declare const stub: DurableObjectStub<HuddleServer>;

const admin = await stub.admin();

expectTypeOf(await admin.onlineCount()).toEqualTypeOf<number>();

// @ts-expect-error — buildAdmin() keeps only function members of `api`, so a value never reaches the stub
await admin.retentionDays;

expectTypeOf<CloudflareAdmin<typeof huddle>>().toHaveProperty('onlineCount');
expectTypeOf<CloudflareAdmin<typeof huddle>>().not.toHaveProperty('retentionDays');
