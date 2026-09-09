import { CAPABILITY_KIND } from '~/_define/capability-kinds.ts';
import { channelOnlyCapability, stampKind, withCapabilityKind } from '~/_define/capability.ts';
import { inbox as inboxFactory } from '~/inbox/inbox.ts';
import { readReceipts as readReceiptsFactory } from '~/inbox/read-receipts.ts';
import { DEFAULT_MAX_RECEIPT_AUDIENCE } from '~/inbox/runtime.ts';
import type { ChannelOnlyCapability } from '~/_define/capability.ts';
import type { ResolvedReadReceiptsOptions } from '~/_engine/runtime/feature-slots.ts';
import type { InboxOptions, ReadReceiptsOptions } from '~/inbox/types.ts';
import type { Primitive } from '~/primitive.ts';

export type { InboxRetention, OnDelivered } from '~/inbox/storage.ts';
export type { InboxOptions, ReadReceiptsOptions } from '~/inbox/types.ts';

/** The capability `inbox(...)` returns — channel-only, so it only appears in a channel's own `capabilities` list. */
export type InboxCapability = ChannelOnlyCapability<{}, never, 'inbox'>;

/** The capability `readReceipts(...)` returns — channel-only, like `InboxCapability`. */
export type ReadReceiptsCapability = ChannelOnlyCapability<
  {},
  never,
  'readReceipts',
  typeof CAPABILITY_KIND.readReceipts
>;

/**
 * Enable guaranteed per-member delivery on a channel. Unlike `replay`
 * (best-effort catch-up on a shared log), inbox writes a real per-member copy
 * on every channel broadcast and holds it until that member acks with
 * `__received__`. List it in that channel's own `capabilities`. Members must
 * have a stable user id — anonymous connections get live-only delivery.
 *
 * Requires `sequence({ persist: true })` and `dedup()` on the host; the build
 * fails without them.
 *
 * @example
 * ```ts
 * import { define, t } from '@wskit/server';
 * import { channels } from '@wskit/server/channels';
 * import { sequence } from '@wskit/server/sequence';
 * import { dedup } from '@wskit/server/dedup';
 * import { inbox } from '@wskit/server/inbox';
 *
 * const base = define({
 *   capabilities: [channels(), sequence({ persist: true }), dedup()],
 * });
 *
 * const chat = base.channel('chat', { capabilities: [inbox()] });
 * ```
 */
export const inbox = withCapabilityKind(function inbox(config: InboxOptions = {}): InboxCapability {
  const cap = channelOnlyCapability<{}, never, 'inbox'>([]);
  attachInboxBuilder(cap, config);
  return stampKind(cap, CAPABILITY_KIND.inbox);
}, CAPABILITY_KIND.inbox);

/**
 * Enable read receipts (the blue check) on an inbox channel. Once listed,
 * `room.markAsRead(seq)` advances a `read_through` cursor, broadcasts a
 * `__read__` fan-out while the channel is within `maxReceiptAudience` (default
 * 256), and answers `ctx.channel.readReceipts.readersOf`. Delivered
 * acknowledgement (the double-grey check) comes with `inbox()` on its own and
 * needs no opt-in.
 *
 * Requires `inbox()` on the same channel; the build fails without it.
 *
 * @example
 * ```ts
 * const chat = base.channel('chat', { capabilities: [inbox(), readReceipts()] });
 * ```
 */
export const readReceipts = withCapabilityKind(function readReceipts(
  config: ReadReceiptsOptions = {},
): ReadReceiptsCapability {
  const cap = channelOnlyCapability<{}, never, 'readReceipts', typeof CAPABILITY_KIND.readReceipts>(
    [],
  );
  attachReadReceiptsBuilder(cap, config);
  return stampKind(cap, CAPABILITY_KIND.readReceipts);
}, CAPABILITY_KIND.readReceipts);

function attachInboxBuilder(cap: InboxCapability, config: InboxOptions): void {
  (cap as { __buildChannelPrimitive?: () => Primitive }).__buildChannelPrimitive = () =>
    inboxFactory(config);
}

function resolveReadReceipts(config: ReadReceiptsOptions): ResolvedReadReceiptsOptions {
  return { maxReceiptAudience: config.maxReceiptAudience ?? DEFAULT_MAX_RECEIPT_AUDIENCE };
}

function attachReadReceiptsBuilder(cap: ReadReceiptsCapability, config: ReadReceiptsOptions): void {
  (cap as { __buildChannelPrimitive?: () => Primitive }).__buildChannelPrimitive = () =>
    readReceiptsFactory(resolveReadReceipts(config));
}
