import type { InboxRetention } from '~/inbox/storage.ts';

/** Inbox settings shared by both `onDelivered` modes. */
interface InboxOptionsBase {
  /**
   * Push a member's delivered `__received__` tick to the other members so they
   * can show the grey double-check. Off by default: the received cursor is always
   * stored and you can still read it via `receiversOf` — this only controls the
   * live push.
   */
  readonly broadcastReceipts?: boolean;
  /**
   * When `broadcastReceipts` is on, only push the tick while the channel has at
   * most this many members. Above it the cursor is still tracked and you can still
   * read it, but the live push is skipped because it costs O(members²).
   * Defaults to {@link DEFAULT_MAX_RECEIPT_AUDIENCE}.
   */
  readonly maxReceiptAudience?: number;
}

/**
 * Per-channel inbox settings. `retention` is required with `onDelivered: 'retain'`
 * (kept rows need a bound so they can age out) — omitting it is a type error and
 * the capability throws the same at build time. In the default `delete` mode
 * `retention` is optional: there it caps the *undelivered* queue, so a member
 * that falls too far behind gets a `__gap__` instead of a backlog that grows
 * forever.
 */
export type InboxOptions =
  | (InboxOptionsBase & { readonly onDelivered?: 'delete'; readonly retention?: InboxRetention })
  | (InboxOptionsBase & { readonly onDelivered: 'retain'; readonly retention: InboxRetention });

/** The channel config value accepted for `inbox`: on/off or an options object. */
export type InboxConfig = boolean | InboxOptions;

/**
 * The default member cap for the live delivered/read receipt fan-out. Above it
 * the cursor is still stored and stays queryable, but the live tick is
 * suppressed because its fan-out is O(members²). Shared by inbox's `__received__`
 * tick and the read-receipts `__read__` tick.
 */
export const DEFAULT_MAX_RECEIPT_AUDIENCE = 256;

/** Read-receipts settings accepted for one channel. */
export interface ReadReceiptsOptions {
  /**
   * Only live-broadcast the read `__read__` frame while the channel has at most
   * this many members. Above it, the read cursor is still tracked and stays
   * queryable via `readersOf`. Defaults to {@link DEFAULT_MAX_RECEIPT_AUDIENCE}.
   */
  readonly maxReceiptAudience?: number;
}

/** The channel config value accepted for `readReceipts`: on/off or an options object. */
export type ReadReceiptsConfig = boolean | ReadReceiptsOptions;
