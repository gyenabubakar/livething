/**
 * Compile-time fixtures for `inbox()` / `readReceipts()` as channel-only
 * capabilities: they belong in a channel's own `capabilities` list, and
 * `readReceipts()` needs `inbox()` listed on that SAME channel.
 */
import { server } from '~/_define/server.ts';
import { channels } from '~/channel/capability.ts';
import { dedup } from '~/dedup/capability.ts';
import { inbox, readReceipts } from '~/inbox/capability.ts';
import { sequence } from '~/sequence/capability.ts';
import { expectTypeOf } from 'vitest';
import type { ChannelOnlyCapability } from '~/_define/capability.ts';
import type { ChannelCtx } from '~/_define/server.ts';
import type { InferClient } from '~/infer-client.ts';

const base = server({
  capabilities: [channels(), sequence({ persist: true }), dedup()],
});

// `inbox()` on a channel's own `capabilities` is fine.
const withInbox = base.channel('with-inbox', { capabilities: [inbox()] });

// `readReceipts()` alone, with no `inbox()` on the same channel, is a build error.
// @ts-expect-error — readReceipts() needs inbox() listed on this same channel.
base.channel('missing-inbox', {
  capabilities: [readReceipts()],
});

// `readReceipts()` alongside `inbox()` on the same channel is fine.
const withBoth = base.channel('with-both', { capabilities: [inbox(), readReceipts()] });

// A channel with neither is fine too — no channel-only capabilities at all.
const withNeither = base.channel('with-neither', {});

const definition = base.assemble({ handlers: [withInbox, withBoth, withNeither] });
type Client = InferClient<typeof definition>;

// A channel with `inbox()` exposes the `inbox: true` client-contract flag.
expectTypeOf<Client['channels']['with-inbox']['inbox']>().toEqualTypeOf<true>();
expectTypeOf<Client['channels']['with-inbox']>().not.toHaveProperty('readReceipts');

// A channel with both exposes both flags.
expectTypeOf<Client['channels']['with-both']['inbox']>().toEqualTypeOf<true>();
expectTypeOf<Client['channels']['with-both']['readReceipts']>().toEqualTypeOf<true>();

// A channel with neither exposes neither flag.
expectTypeOf<Client['channels']['with-neither']>().not.toHaveProperty('inbox');
expectTypeOf<Client['channels']['with-neither']>().not.toHaveProperty('readReceipts');

// `ctx.channel.inbox` is a non-null property inside the owning channel's own
// handler when that channel lists `inbox()` — not a cast, not the nullable
// `handle.inbox()` method.
export const handleInboxBackfill = withInbox.on('backfill', {
  run(ctx) {
    expectTypeOf(ctx.channel.inbox.backfill).toBeFunction();
    ctx.channel.inbox.backfill('user-1', []);
    expectTypeOf(ctx.channel.inbox.receiversOf(1)).toEqualTypeOf<string[]>();
  },
});

// Reading `ctx.channel.inbox` on a channel that never listed `inbox()` is a compile error.
export const handleNoInbox = withNeither.on('no-inbox', {
  run(ctx) {
    // @ts-expect-error — this channel has no inbox() capability listed.
    ctx.channel.inbox;
  },
});

// `ctx.channel.readReceipts` is a non-null property inside the owning channel's
// own handler when that channel lists `readReceipts()`.
export const handleReadReceipts = withBoth.on('mark-read', {
  run(ctx) {
    expectTypeOf(ctx.channel.readReceipts.readersOf).toBeFunction();
    // `withBoth` also lists `inbox()`, so both arms are present together.
    expectTypeOf(ctx.channel.inbox.backfill).toBeFunction();
  },
});

// Reading `ctx.channel.readReceipts` on a channel that lists `inbox()` but not
// `readReceipts()` is a compile error.
export const handleNoReadReceipts = withInbox.on('no-read-receipts', {
  run(ctx) {
    // @ts-expect-error — this channel has inbox() but not readReceipts() listed.
    ctx.channel.readReceipts;
  },
});

const handlerWithArms = base.assemble({
  handlers: [
    withInbox,
    withBoth,
    withNeither,
    handleInboxBackfill,
    handleNoInbox,
    handleReadReceipts,
    handleNoReadReceipts,
  ],
});
type ClientWithArms = InferClient<typeof handlerWithArms>;
expectTypeOf<ClientWithArms['channels']['with-inbox']['inbox']>().toEqualTypeOf<true>();

// A handle from `ctx.channels.get(...)` still returns the nullable method form —
// it may name any channel, so it cannot promise the capability is present.
export const handleFromGetHandle = base.on('from-get-handle', {
  run(ctx) {
    const handle = ctx.channels.get(withInbox);
    expectTypeOf(handle.inbox()).toEqualTypeOf<ReturnType<typeof handle.inbox>>();
    expectTypeOf(handle.inbox).toBeFunction();
    expectTypeOf(handle.readReceipts).toBeFunction();
  },
});

// A `capabilities` array typed exactly as the `capabilities` config field's own
// type — `ChannelOnlyCapability<{}, never, string>[]` — is a widened brand, not
// a literal union, so `base.channel(...)` rejects it outright rather than
// silently granting nothing it lists.
declare const widenedCaps: ChannelOnlyCapability<{}, never, string>[];
// @ts-expect-error — a widened capabilities array is rejected outright.
base.channel('widened-bypass', { capabilities: widenedCaps });

// The same widened brand reaching `ChannelCtx` directly (the type that grants
// `ctx.channel.inbox` / `ctx.channel.readReceipts`) does not grant either arm.
type WidenedChannelCtx = ChannelCtx<{}, {}, {}, {}, readonly [], {}, string>;
expectTypeOf<WidenedChannelCtx['channel']>().not.toHaveProperty('inbox');
expectTypeOf<WidenedChannelCtx['channel']>().not.toHaveProperty('readReceipts');

export type {};
