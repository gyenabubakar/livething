/**
 * Compile-time fixtures for `inbox()` / `readReceipts()` as channel-only
 * capabilities: they belong in a channel's own `capabilities` list, and
 * `readReceipts()` needs `inbox()` listed on that SAME channel.
 */
import { t } from '~/_api/index.ts';
import { define } from '~/_define/define.ts';
import { channels } from '~/channel/capability.ts';
import { dedup } from '~/dedup/capability.ts';
import { inbox, readReceipts } from '~/inbox/capability.ts';
import { sequence } from '~/sequence/capability.ts';
import { expectTypeOf } from 'vitest';
import type { InferClient } from '~/infer-client.ts';

const base = define({
  env: t<Record<string, never>>(),
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

const handler = base.assemble({ handlers: [withInbox, withBoth, withNeither] });
type Client = InferClient<typeof handler>;

// A channel with `inbox()` exposes the `inbox: true` client-contract flag.
expectTypeOf<Client['channels']['with-inbox']['inbox']>().toEqualTypeOf<true>();
expectTypeOf<Client['channels']['with-inbox']>().not.toHaveProperty('readReceipts');

// A channel with both exposes both flags.
expectTypeOf<Client['channels']['with-both']['inbox']>().toEqualTypeOf<true>();
expectTypeOf<Client['channels']['with-both']['readReceipts']>().toEqualTypeOf<true>();

// A channel with neither exposes neither flag.
expectTypeOf<Client['channels']['with-neither']>().not.toHaveProperty('inbox');
expectTypeOf<Client['channels']['with-neither']>().not.toHaveProperty('readReceipts');

export type {};
