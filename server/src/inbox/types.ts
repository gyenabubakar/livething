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
   * Only live-broadcast the delivered `__receipt__` tick while the channel has at
   * most this many members. Above it, the received cursor is still tracked and
   * stays queryable via `receivedBy`. Defaults to {@link DEFAULT_RECEIPT_BROADCAST_UP_TO}.
   */
  readonly broadcastUpTo?: number;
}

/** The channel config value accepted for `inbox`: on/off or an options object. */
export type InboxConfig = boolean | InboxOptions;

/**
 * The default member cap for the live delivered/read `__receipt__` broadcast.
 * Above it the cursor is still stored and stays queryable, but the live tick is
 * suppressed because its fan-out is O(members²). Shared by inbox's delivered tick
 * and the read-receipts tick.
 */
export const DEFAULT_RECEIPT_BROADCAST_UP_TO = 256;

/** Read-receipts settings accepted for one channel. */
export interface ReadReceiptsOptions {
  /**
   * Only live-broadcast the read `__receipt__` frame while the channel has at
   * most this many members. Above it, the seen cursor is still tracked and stays
   * queryable via `seenBy`. Defaults to {@link DEFAULT_RECEIPT_BROADCAST_UP_TO}.
   */
  readonly broadcastUpTo?: number;
}

/** The channel config value accepted for `readReceipts`: on/off or an options object. */
export type ReadReceiptsConfig = boolean | ReadReceiptsOptions;
