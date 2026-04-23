import { event, server } from '@wskit/server';
import { withLifecycle } from '@wskit/server/lifecycle';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const KvSet = event(
  'kv-set',
  v.object({ key: v.string(), value: v.string(), ttlMs: v.optional(v.number()) }),
);
const KvGet = event('kv-get', v.object({ key: v.string() }));
const KvDelete = event('kv-delete', v.object({ key: v.string() }));
const KvSetGet = event('kv-set-get', v.object({ key: v.string(), value: v.string() }));
const KvResult = event('kv-result', v.object({ key: v.string(), value: v.nullable(v.string()) }));

export const ctxKvHandler = withLifecycle(server<Env>('ctx-kv'))
  .outgoing(KvResult)
  .onUpgrade((request) => requireUsername(request))
  .incoming(KvSet, async (ctx, payload) => {
    await ctx.kv.set(
      payload.key,
      payload.value,
      payload.ttlMs ? { ttl: payload.ttlMs } : undefined,
    );
    ctx.send('kv-result', { key: payload.key, value: payload.value });
  })
  .incoming(KvGet, async (ctx, payload) => {
    const raw = await ctx.kv.get(payload.key);
    const value = (raw ?? null) as string | null;
    ctx.send('kv-result', { key: payload.key, value });
  })
  .incoming(KvDelete, async (ctx, payload) => {
    await ctx.kv.delete(payload.key);
    ctx.send('kv-result', { key: payload.key, value: null });
  })
  .incoming(KvSetGet, async (ctx, payload) => {
    await ctx.kv.set(payload.key, payload.value);
    const value = (await ctx.kv.get(payload.key)) as string | null;
    ctx.send('kv-result', { key: payload.key, value });
  })
  .build();
