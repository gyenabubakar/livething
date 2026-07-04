import { CAPABILITY_KIND } from '~/_define/capability-kinds.ts';
import { hostCapability, stampKind, withCapabilityKind } from '~/_define/capability.ts';
import { inbox as inboxFactory } from '~/inbox/inbox.ts';
import { receipts as receiptsFactory } from '~/inbox/receipts.ts';
import type { HostCapability } from '~/_define/capability.ts';
import type { InboxConfig, InboxOptions, ReceiptsConfig, ReceiptsOptions } from '~/inbox/types.ts';
import type { Primitive } from '~/primitive.ts';

export type {
  InboxOptions,
  ReceiptsOptions,
  AfterDelivered,
  InboxRetention,
} from '~/inbox/types.ts';

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
 * Enable delivered + seen acknowledgements on inbox channels. When on, a
 * member's `__received__` advances a `received_through` cursor, and (with
 * `seen: true`) `room.markSeen(seq)` advances `seen_through`. Both are broadcast
 * to the channel as `__receipt__` frames while the channel is within
 * `broadcastUpTo`, and are always queryable via `ctx.channel.receipts`.
 *
 * Requires `inbox()` (and its `sequence`/`persistence`); the build fails without it.
 *
 * @example
 * ```ts
 * capabilities: [channels(), persistence(), sequence({ persist: true }), dedup(), inbox(), receipts()];
 * ```
 */
export const receipts = withCapabilityKind(function receipts(): HostCapability<{}, never> {
  const cap = hostCapability<{}, never>([]);
  attachReceiptsBuilder(cap);
  return stampKind(cap, CAPABILITY_KIND.receipts);
}, CAPABILITY_KIND.receipts);

function normalizeInbox(config: InboxConfig): InboxOptions {
  return config === true ? {} : (config as InboxOptions);
}

function attachInboxBuilder(cap: HostCapability<{}, never>): void {
  (cap as { __buildInbox?: (config: unknown) => Primitive }).__buildInbox = (config) =>
    inboxFactory(normalizeInbox(config as InboxConfig));
}

function normalizeReceipts(config: ReceiptsConfig): ReceiptsOptions {
  return config === true ? {} : (config as ReceiptsOptions);
}

function attachReceiptsBuilder(cap: HostCapability<{}, never>): void {
  (cap as { __buildReceipts?: (config: unknown) => Primitive }).__buildReceipts = (config) =>
    receiptsFactory(normalizeReceipts(config as ReceiptsConfig));
}
