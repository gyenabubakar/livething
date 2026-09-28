import { channels } from '~/channel/capability.ts';
import { emits, server, t } from '~/index.ts';
import { scheduled } from '~/scheduled/capability.ts';
import { expectTypeOf } from 'vitest';
import type { UnlistedAdminContextMember } from './context.ts';

// A top-level (app) assemble types its api ctx as the connectionless admin ctx:
// engine-wide ops are present, per-connection members are not.
const app = server({
  capabilities: [emits({ ping: t<{ n: number }>() })],
});
const go = app.on('go', { run() {} });

app.assemble({
  handlers: [go],
  api: (ctx) => {
    expectTypeOf(ctx).toHaveProperty('broadcast');
    expectTypeOf(ctx).toHaveProperty('purgeUser');
    expectTypeOf(ctx).toHaveProperty('closeConnections');
    expectTypeOf(ctx).toHaveProperty('sql');
    expectTypeOf(ctx).toHaveProperty('connections');

    expectTypeOf(ctx).toHaveProperty('users');
    expectTypeOf(ctx.connectionCount).toEqualTypeOf<number>();

    // @ts-expect-error — no current connection on the admin ctx
    ctx.send;
    // @ts-expect-error — no current connection on the admin ctx
    ctx.id;
    // @ts-expect-error — no current connection on the admin ctx
    ctx.meta;
    // @ts-expect-error — `channels` is owned by the channels() capability
    ctx.channels;
    // @ts-expect-error — `schedule` is owned by the scheduled() capability
    ctx.schedule;
    // @ts-expect-error — `cancelScheduled` is owned by the scheduled() capability
    ctx.cancelScheduled;

    expectTypeOf(ctx.purgeUser)
      .parameter(1)
      .toEqualTypeOf<{ keepBroadcastContent?: boolean } | undefined>();

    return {
      evict: (id: string) => ctx.purgeUser(id),
      evictKeepingBroadcasts: (id: string) => ctx.purgeUser(id, { keepBroadcastContent: true }),
    };
  },
});

// Listing the owning capability puts the gated members back, typed.
const full = server({
  capabilities: [
    emits({ ping: t<{ n: number }>() }),
    channels(),
    scheduled({ sweep: { data: t<{ room: string }>() } }),
  ],
});
const tick = full.on('tick', { run() {} });

full.assemble({
  handlers: [tick],
  api: (ctx) => {
    expectTypeOf(ctx).toHaveProperty('channels');
    expectTypeOf(ctx.channels.get('lobby')).toHaveProperty('broadcast');

    ctx.schedule('sweep', { time: 1, data: { room: 'lobby' } });
    // @ts-expect-error — task id must be one the scheduled() capability declared
    ctx.schedule('nope', { time: 1, data: { room: 'lobby' } });

    return {};
  },
});

// The member list adapters read must stay in step with the context it describes:
// adding a member to AdminContext without listing it fails here.
expectTypeOf<UnlistedAdminContextMember>().toEqualTypeOf<never>();
