import { contract, implement, incoming, outgoing, t } from '@wskit/server';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

export const ctxKvContract = contract('ctx-kv', {
  env: t<Env>(),
  meta: t<{ username: string }>(),
  definitions: [
    incoming(
      'kv-set',
      v.object({ key: v.string(), value: v.string(), ttlMs: v.optional(v.number()) }),
    ),
    incoming('kv-get', v.object({ key: v.string() })),
    incoming('kv-delete', v.object({ key: v.string() })),
    incoming('kv-set-get', v.object({ key: v.string(), value: v.string() })),
    incoming('kv-list-probe', v.object({ prefix: v.string() })),
    incoming('kv-ttl-zero-probe', v.object({ key: v.string(), value: v.string() })),

    outgoing('kv-result', v.object({ key: v.string(), value: v.nullable(v.string()) })),
    outgoing('kv-list-result', v.object({ keys: v.array(v.string()) })),
  ],
});

export const ctxKvHandler = implement(ctxKvContract)
  .onUpgrade((request) => requireUsername(request))
  .on('kv-set', async (ctx, payload) => {
    await ctx.kv.set(
      payload.key,
      payload.value,
      payload.ttlMs ? { ttl: payload.ttlMs } : undefined,
    );
    ctx.send('kv-result', { key: payload.key, value: payload.value });
  })
  .on('kv-get', async (ctx, payload) => {
    const raw = await ctx.kv.get(payload.key);
    const value = (raw ?? null) as string | null;
    ctx.send('kv-result', { key: payload.key, value });
  })
  .on('kv-delete', async (ctx, payload) => {
    await ctx.kv.delete(payload.key);
    ctx.send('kv-result', { key: payload.key, value: null });
  })
  .on('kv-set-get', async (ctx, payload) => {
    await ctx.kv.set(payload.key, payload.value);
    const value = (await ctx.kv.get(payload.key)) as string | null;
    ctx.send('kv-result', { key: payload.key, value });
  })
  .on('kv-list-probe', async (ctx, payload) => {
    await ctx.kv.set(`${payload.prefix}:a`, '1');
    await ctx.kv.set(`${payload.prefix}:b`, '2');
    await ctx.kv.set('other-prefix:c', '3');
    const keys = await ctx.kv.list(payload.prefix);
    ctx.send('kv-list-result', { keys });
  })
  .on('kv-ttl-zero-probe', async (ctx, payload) => {
    // ttl: 0 means "no expiry" — the value must still be readable afterwards.
    await ctx.kv.set(payload.key, payload.value, { ttl: 0 });
    const value = (await ctx.kv.get(payload.key)) as string | null;
    ctx.send('kv-result', { key: payload.key, value });
  })
  .build();

export type CtxKvClient = InferClient<typeof ctxKvHandler>;
