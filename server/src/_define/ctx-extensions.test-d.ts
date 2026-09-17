/* oxlint-disable no-unused-vars */
/**
 * Compile-time fixtures for capability-gated ctx surfaces and owner threading.
 *
 * Covers: `base.onInit`/`base.onShutdown` and shutdown's `broadcast` are typed
 * to declared emits (gap 5); `frame.owner.id` is the union
 * of registered plugin ids in `intercept`/`outgoing` (gap 7); and each
 * capability-owned ctx arm exists only when its capability is listed, and is a
 * compile error otherwise (gap 9).
 */
import { t } from '~/_api/index.ts';
import { plugin } from '~/_define/plugins.ts';
import { server } from '~/_define/server.ts';
import { channels } from '~/channel/capability.ts';
import { emits } from '~/emits/emits.ts';
import { intercepts } from '~/intercept/capability.ts';
import { keepalive } from '~/keepalive/capability.ts';
import { serverRequests } from '~/request/server-requests.ts';
import { scheduled } from '~/scheduled/capability.ts';
import { tags } from '~/tags/capability.ts';
import * as v from 'valibot';
import { expectTypeOf } from 'vitest';

// ---------------------------------------------------------------------------
// Gap 5 — gated broadcast in `init` / `shutdown`.
// ---------------------------------------------------------------------------
const lifecycleBase = server({
  upgrade: () => ({ userId: 'u', meta: { who: 'x' } }),
  capabilities: [emits({ bye: t<{ reason: string }>() })],
});

lifecycleBase.onInit((ctx) => {
  void ctx;
});

lifecycleBase.onShutdown((ctx) => {
  // Broadcast is gated to declared emits with the correct payload.
  ctx.broadcast('bye', { reason: 'restart' });
  // @ts-expect-error — wrong payload for a declared emit
  ctx.broadcast('bye', { reason: 123 });
  // @ts-expect-error — undeclared event
  ctx.broadcast('nope', { reason: 'x' });
});

// ---------------------------------------------------------------------------
// Gap 7 — `frame.owner.id` typed to the union of registered plugin ids.
// ---------------------------------------------------------------------------
const scopedA = server({ scope: 'plugin', capabilities: [emits({ a: t<{}>() })] });
const PluginA = plugin('acme:a', {
  definition: scopedA.assemble({ handlers: [scopedA.on('a-in', { run() {} })] }),
});

const scopedC = server({ scope: 'plugin', capabilities: [emits({ c: t<{}>() })] });
const PluginC = plugin('acme:c', {
  definition: scopedC.assemble({ handlers: [scopedC.on('c-in', { run() {} })] }),
});

const ownerBase = server({ capabilities: [PluginA(), PluginC(), intercepts()] });

ownerBase.intercept((ctx, frame) => {
  void ctx;
  if (frame.owner.kind === 'plugin') {
    expectTypeOf(frame.owner.id).toEqualTypeOf<'acme:a' | 'acme:c'>();
    const _id: 'acme:a' | 'acme:c' = frame.owner.id;
    void _id;
    // @ts-expect-error — a made-up id is not in the registered union
    const _bad: 'acme:nope' = frame.owner.id;
    void _bad;
  }
});

ownerBase.onOutgoing((ctx, frame) => {
  void ctx;
  if (frame.owner.kind === 'plugin') {
    expectTypeOf(frame.owner.id).toEqualTypeOf<'acme:a' | 'acme:c'>();
  }
});

// ---------------------------------------------------------------------------
// Gap 9 — capability-gated ctx arms (CtxExtensionsOf).
// ---------------------------------------------------------------------------

// A bare server: none of the capability arms exist.
const bareBase = server({ capabilities: [emits({ e: t<{}>() })] });
bareBase.on('bare', {
  run(ctx) {
    // @ts-expect-error — `request` needs serverRequests()
    ctx.request('x', {});
    // @ts-expect-error — `broadcastRequest` needs serverRequests()
    ctx.broadcastRequest('x', {});
    // @ts-expect-error — `tags` needs tags()
    ctx.tags;
    // @ts-expect-error — `channels` needs channels()
    ctx.channels;
    // @ts-expect-error — `schedule` needs scheduled()
    ctx.schedule('x', { time: 0 });
    // @ts-expect-error — `plugin` needs a registered plugin
    ctx.plugin('acme:a');
    // @ts-expect-error — `latency` needs keepalive()
    ctx.latency;
    // @ts-expect-error — `quality` needs keepalive()
    ctx.quality;
  },
});

// A server that lists every gating capability: each arm is present.
const fullBase = server({
  capabilities: [
    emits({ e: t<{}>() }),
    serverRequests({
      r: { out: t<{}>(), in: v.object({ ok: v.boolean() }) },
      br: { out: t<{}>(), in: v.object({ ok: v.boolean() }) },
    }),
    tags((ephemeral) => [ephemeral('grp', t<string>())]),
    channels(),
    scheduled({ task: null }),
    keepalive({ pingIntervalMs: 30_000, idleTimeoutMs: 60_000 }),
    PluginA(),
  ],
});
fullBase.on('full', {
  run(ctx) {
    expectTypeOf(ctx.request).toBeFunction();
    expectTypeOf(ctx.broadcastRequest).toBeFunction();
    expectTypeOf(ctx.tags).not.toBeUndefined();
    expectTypeOf(ctx.channels).not.toBeUndefined();
    expectTypeOf(ctx.schedule).toBeFunction();

    expectTypeOf(ctx.plugin).toBeFunction();
    expectTypeOf(ctx.latency).toEqualTypeOf<number | null>();
    expectTypeOf(ctx.quality).toEqualTypeOf<'excellent' | 'good' | 'degraded' | 'poor' | null>();
  },
});
