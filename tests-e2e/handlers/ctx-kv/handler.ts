import { define, emits, t } from '@wskit/server';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

const base = define({
  upgrade: (request) => requireUsername(request),
  capabilities: [
    emits({
      'kv-result': t<{ key: string; value: string | null }>(),
      'kv-list-result': t<{ keys: string[] }>(),
    }),
  ],
});

const handleKvSet = base.on('kv-set', {
  input: v.object({ key: v.string(), value: v.string(), ttlMs: v.optional(v.number()) }),
  async run(ctx, input) {
    await ctx.kv.set(input.key, input.value, input.ttlMs ? { ttl: input.ttlMs } : undefined);
    ctx.send('kv-result', { key: input.key, value: input.value });
  },
});

const handleKvGet = base.on('kv-get', {
  input: v.object({ key: v.string() }),
  async run(ctx, input) {
    const raw = await ctx.kv.get(input.key);
    const value = (raw ?? null) as string | null;
    ctx.send('kv-result', { key: input.key, value });
  },
});

const handleKvDelete = base.on('kv-delete', {
  input: v.object({ key: v.string() }),
  async run(ctx, input) {
    await ctx.kv.delete(input.key);
    ctx.send('kv-result', { key: input.key, value: null });
  },
});

const handleKvSetGet = base.on('kv-set-get', {
  input: v.object({ key: v.string(), value: v.string() }),
  async run(ctx, input) {
    await ctx.kv.set(input.key, input.value);
    const value = (await ctx.kv.get(input.key)) as string | null;
    ctx.send('kv-result', { key: input.key, value });
  },
});

const handleKvListProbe = base.on('kv-list-probe', {
  input: v.object({ prefix: v.string() }),
  async run(ctx, input) {
    await ctx.kv.set(`${input.prefix}:a`, '1');
    await ctx.kv.set(`${input.prefix}:b`, '2');
    await ctx.kv.set('other-prefix:c', '3');
    const keys = await ctx.kv.list(input.prefix);
    ctx.send('kv-list-result', { keys });
  },
});

const handleKvTtlZeroProbe = base.on('kv-ttl-zero-probe', {
  input: v.object({ key: v.string(), value: v.string() }),
  async run(ctx, input) {
    // ttl: 0 means "no expiry" — the value must still be readable afterwards.
    await ctx.kv.set(input.key, input.value, { ttl: 0 });
    const value = (await ctx.kv.get(input.key)) as string | null;
    ctx.send('kv-result', { key: input.key, value });
  },
});

export const ctxKvHandler = base.assemble({
  handlers: [
    handleKvSet,
    handleKvGet,
    handleKvDelete,
    handleKvSetGet,
    handleKvListProbe,
    handleKvTtlZeroProbe,
  ],
});

export type CtxKvClient = InferClient<typeof ctxKvHandler>;
