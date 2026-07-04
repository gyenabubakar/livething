import type { AfterDelivered, InboxRetention } from '~/inbox/storage.ts';

export type { AfterDelivered, InboxRetention } from '~/inbox/storage.ts';

/**
 * Resolved inbox settings for one channel. `afterDelivered: 'keep'` requires
 * `retention`; the capability validates that at build time.
 */
export interface InboxOptions {
  readonly afterDelivered?: AfterDelivered;
  readonly retention?: InboxRetention;
  /**
   * Only live-broadcast the delivered `__received__` tick while the channel has
   * at most this many members. Above it, the received cursor is still tracked and
   * stays queryable via `receiversOf`. Defaults to {@link DEFAULT_RECEIPT_BROADCAST_UP_TO}.
   */
  readonly broadcastUpTo?: number;
}

/** The channel config value accepted for `inbox`: on/off or an options object. */
export type InboxConfig = boolean | InboxOptions;

/**
 * The default member cap for the live delivered/read receipt fan-out. Above it
 * the cursor is still stored and stays queryable, but the live tick is
 * suppressed because its fan-out is O(members²). Shared by inbox's `__received__`
 * tick and the read-receipts `__read__` tick.
 */
export const DEFAULT_RECEIPT_BROADCAST_UP_TO = 256;

/** Read-receipts settings accepted for one channel. */
export interface ReadReceiptsOptions {
  /**
   * Only live-broadcast the read `__read__` frame while the channel has at most
   * this many members. Above it, the read cursor is still tracked and stays
   * queryable via `readersOf`. Defaults to {@link DEFAULT_RECEIPT_BROADCAST_UP_TO}.
   */
  readonly broadcastUpTo?: number;
}

/** The channel config value accepted for `readReceipts`: on/off or an options object. */
export type ReadReceiptsConfig = boolean | ReadReceiptsOptions;
