import { CAPABILITY_KIND } from '~/_define/capability-kinds.ts';
import { hostCapability, stampKind, withCapabilityKind } from '~/_define/capability.ts';
import { inbox as inboxFactory } from '~/inbox/inbox.ts';
import { readReceipts as readReceiptsFactory } from '~/inbox/read-receipts.ts';
import { DEFAULT_MAX_RECEIPT_AUDIENCE } from '~/inbox/runtime.ts';
import type { HostCapability } from '~/_define/capability.ts';
import type { ResolvedReadReceiptsOptions } from '~/_engine/runtime/feature-slots.ts';
import type {
  InboxConfig,
  InboxOptions,
  ReadReceiptsConfig,
  ReadReceiptsOptions,
} from '~/inbox/types.ts';
import type { Primitive } from '~/primitive.ts';

export type { InboxRetention, OnDelivered } from '~/inbox/storage.ts';
export type { InboxOptions, ReadReceiptsOptions } from '~/inbox/types.ts';

/**
 * Enable guaranteed per-member delivery on channels. Unlike `replay` (best-effort
 * catch-up on a shared log), inbox writes a real per-member copy on every channel
 * broadcast and holds it until that member acks with `__received__`. Turn it on
 * per channel with `inbox: true` (or an options object) inside a channel
 * definition. Members must have a stable identity — anonymous connections get
 * live-only delivery.
 *
 * Requires `channels()`, `persistence()`, `sequence({ persist: true })`, and
 * `dedup()`; the build fails without them.
 *
 * @example
 * ```ts
 * import { define, t } from '@wskit/server';
 * import { channels } from '@wskit/server/channels';
 * import { persistence } from '@wskit/server/persistence';
 * import { sequence } from '@wskit/server/sequence';
 * import { dedup } from '@wskit/server/dedup';
 * import { inbox } from '@wskit/server/inbox';
 *
 * const base = define({
 *   env: t<Env>(),
 *   capabilities: [channels(), persistence(), sequence({ persist: true }), dedup(), inbox()],
 * });
 * ```
 */
export const inbox = withCapabilityKind(function inbox(): HostCapability<{}, never> {
  const cap = hostCapability<{}, never>([]);
  attachInboxBuilder(cap);
  return stampKind(cap, CAPABILITY_KIND.inbox);
}, CAPABILITY_KIND.inbox);

/**
 * Enable read receipts (the blue check) on inbox channels. When a channel opts
 * in with `readReceipts: true`, `room.markAsRead(seq)` advances a `read_through`
 * cursor, broadcasts a `__read__` fan-out while the channel is within
 * `maxReceiptAudience` (default 256), and answers `ctx.channel.readReceipts.readersOf`.
 * Delivered acknowledgement (the double-grey check) comes with `inbox()` on its
 * own and needs no opt-in.
 *
 * Requires `inbox()` (and its `sequence`/`persistence`); the build fails without it.
 *
 * @example
 * ```ts
 * capabilities: [
 *   channels(),
 *   persistence(),
 *   sequence({ persist: true }),
 *   dedup(),
 *   inbox(),
 *   readReceipts(),
 * ];
 * ```
 */
export const readReceipts = withCapabilityKind(function readReceipts(): HostCapability<{}, never> {
  const cap = hostCapability<{}, never>([]);
  attachReadReceiptsBuilder(cap);
  return stampKind(cap, CAPABILITY_KIND.readReceipts);
}, CAPABILITY_KIND.readReceipts);

function normalizeInbox(config: InboxConfig): InboxOptions {
  return config === true ? {} : (config as InboxOptions);
}

function attachInboxBuilder(cap: HostCapability<{}, never>): void {
  (cap as { __buildInbox?: (config: unknown) => Primitive }).__buildInbox = (config) =>
    inboxFactory(normalizeInbox(config as InboxConfig));
}

function resolveReadReceipts(config: ReadReceiptsConfig): ResolvedReadReceiptsOptions {
  const options: ReadReceiptsOptions = config === true || config === false ? {} : config;
  return { maxReceiptAudience: options.maxReceiptAudience ?? DEFAULT_MAX_RECEIPT_AUDIENCE };
}

function attachReadReceiptsBuilder(cap: HostCapability<{}, never>): void {
  (cap as { __buildReadReceipts?: (config: unknown) => Primitive }).__buildReadReceipts = (
    config,
  ) => readReceiptsFactory(resolveReadReceipts(config as ReadReceiptsConfig));
}
