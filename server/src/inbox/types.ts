import type { AfterDelivered, InboxRetention } from '~/inbox/storage.ts';

export type { AfterDelivered, InboxRetention } from '~/inbox/storage.ts';

/**
 * Resolved inbox settings for one channel. `afterDelivered: 'keep'` requires
 * `retention`; the capability validates that at build time.
 */
export interface InboxOptions {
  readonly afterDelivered?: AfterDelivered;
  readonly retention?: InboxRetention;
}

/** The channel config value accepted for `inbox`: on/off or an options object. */
export type InboxConfig = boolean | InboxOptions;

/** Resolved receipts settings for one channel. */
export interface ReceiptsOptions {
  /** Track a `seen` cursor in addition to `received`. Default `false`. */
  readonly seen?: boolean;
  /**
   * Only live-broadcast `__receipt__` frames while the channel has at most this
   * many members. Above it, cursors are still tracked and queryable. Default
   * unlimited.
   */
  readonly broadcastUpTo?: number;
}

/** The channel config value accepted for `receipts`: on/off or an options object. */
export type ReceiptsConfig = boolean | ReceiptsOptions;
