/**
 * Compile-time fixtures for a widened `capabilities` array — one typed
 * `AnyCapability[]` (or the config field's own bare type) rather than staying
 * inferred as a literal-brand tuple. `BrandsOf` collapses that widened union
 * to `never`, so every gate keyed off it closes at once instead of opening
 * for every brand simultaneously.
 */
import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { channels } from '~/channel/capability.ts';
import { keepalive } from '~/keepalive/capability.ts';
import { lastSeen } from '~/last-seen/capability.ts';
import { rateLimit } from '~/rate-limit/capability.ts';
import { replay } from '~/replay/capability.ts';
import { serverRequests } from '~/request/server-requests.ts';
import { scheduled } from '~/scheduled/capability.ts';
import * as v from 'valibot';
import { expectTypeOf } from 'vitest';
import type { AnyCapability } from '~/_define/capability.ts';

// ---------------------------------------------------------------------------
// Negative — a widened host `capabilities` array grants nothing.
// ---------------------------------------------------------------------------

declare const widenedCaps: AnyCapability[];
const base = server({ capabilities: widenedCaps });

// channels() cannot be confirmed listed either, once the array has widened —
// every gate closes together, so `base.channel` itself is gone, not just its
// rateLimit field.
// @ts-expect-error — channels() is not confirmed listed, so base.channel is absent.
base.channel('room', { rateLimit: { max: 5 } });

// @ts-expect-error — channels() is not confirmed listed, so base.channel is absent.
base.channel('room2', {
  capabilities: [serverRequests({ ask: { out: t<{}>(), in: v.object({}) } })],
});

base.on('ping', {
  input: v.object({}),
  run(ctx) {
    // @ts-expect-error — channels() is not confirmed listed, so ctx.channels is absent.
    ctx.channels;
    // @ts-expect-error — scheduled() is not confirmed listed, so ctx.schedule is absent.
    ctx.schedule;
    // @ts-expect-error — keepalive() is not confirmed listed, so ctx.latency is absent.
    // `FeaturesOf` must collapse the same way `BrandsOf` does, or this widened
    // array types every feature flag as turned on, and ctx.latency would pass.
    ctx.latency;
    // @ts-expect-error — lastSeen() is not confirmed listed, so ctx.lastSeen is absent.
    ctx.lastSeen;
    // @ts-expect-error — no replay capability is confirmed listed, so ctx.sendReplay is absent.
    ctx.sendReplay;
  },
});

// An inline, literal-brand `capabilities` array grants exactly what it lists.

const rateLimitBase = server({
  capabilities: [channels(), rateLimit({ max: 5 })],
});
rateLimitBase.channel('room', { rateLimit: { max: 5 } });

const requestsBase = server({
  capabilities: [channels(), serverRequests()],
});
requestsBase.channel('room2', {
  capabilities: [serverRequests({ ask: { out: t<{}>(), in: v.object({}) } })],
});

const channelsBase = server({
  capabilities: [channels()],
});
channelsBase.on('ping', {
  input: v.object({}),
  run(ctx) {
    expectTypeOf(ctx.channels).not.toBeUndefined();
  },
});

const scheduledBase = server({
  capabilities: [scheduled({ task: null })],
});
scheduledBase.on('ping', {
  input: v.object({}),
  run(ctx) {
    expectTypeOf(ctx.schedule).not.toBeUndefined();
  },
});

const keepaliveBase = server({
  capabilities: [keepalive({ pingIntervalMs: 30_000, idleTimeoutMs: 60_000 })],
});
keepaliveBase.on('ping', {
  input: v.object({}),
  run(ctx) {
    expectTypeOf(ctx.latency).toEqualTypeOf<number | null>();
  },
});

const lastSeenBase = server({
  capabilities: [lastSeen()],
});
lastSeenBase.on('ping', {
  input: v.object({}),
  run(ctx) {
    expectTypeOf(ctx.lastSeen).not.toBeUndefined();
    expectTypeOf(ctx.users.get('user_9').isOnline()).toEqualTypeOf<boolean>();
    expectTypeOf(ctx.user.isOnline()).toEqualTypeOf<boolean>();
    const [first] = ctx.connections.all();
    expectTypeOf(first!.lastSeen?.()).toEqualTypeOf<number | null | undefined>();

    expectTypeOf(ctx.users.get('user_9').info()?.lastSeen?.()).toEqualTypeOf<
      number | null | undefined
    >();
  },
});

const replayBase = server({
  capabilities: [replay.history()],
});
replayBase.on('ping', {
  input: v.object({}),
  run(ctx) {
    expectTypeOf(ctx.sendReplay).toBeFunction();
  },
});

export type {};
