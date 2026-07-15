import { define, emits, t } from '~/index.ts';
import { expectTypeOf } from 'vitest';

// A top-level (app) assemble types its api ctx as the connectionless AdminContext:
// engine-wide ops are present, per-connection members are not.
const app = define({
  env: t<{ SECRET: string }>(),
  capabilities: [emits({ ping: t<{ n: number }>() })],
});
const go = app.on('go', { run() {} });

app.assemble({
  handlers: [go],
  api: (ctx) => {
    expectTypeOf(ctx).toHaveProperty('broadcast');
    expectTypeOf(ctx).toHaveProperty('purgeIdentity');
    expectTypeOf(ctx).toHaveProperty('channels');
    expectTypeOf(ctx).toHaveProperty('closeConnections');
    expectTypeOf(ctx).toHaveProperty('sql');

    // @ts-expect-error — no current connection on the admin ctx
    ctx.send;
    // @ts-expect-error — no current connection on the admin ctx
    ctx.id;
    // @ts-expect-error — no current connection on the admin ctx
    ctx.meta;

    return { evict: (id: string) => ctx.purgeIdentity(id) };
  },
});

// A scoped (plugin) assemble types its api ctx as the per-connection AppCtx:
// send / id are present, exactly as the plugin's own handlers see.
const scoped = define({
  scoped: true,
  capabilities: [emits({ up: t<{ id: string }>() })],
});
const beat = scoped.on('beat', { run() {} });

scoped.assemble({
  handlers: [beat],
  api: (ctx) => {
    expectTypeOf(ctx).toHaveProperty('send');
    expectTypeOf(ctx.id).toEqualTypeOf<string>();
    return { whoAmI: () => ctx.id };
  },
});
