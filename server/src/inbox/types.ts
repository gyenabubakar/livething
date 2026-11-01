import type { InboxRetention } from '~/inbox/storage.ts';

/**
 * Per-channel inbox settings. An acknowledged row is deleted, so `retention`
 * bounds the undelivered queue: pruning a row raises an overflow gap.
 * `maxAgeMs` is also swept by the shared durable alarm while a channel is quiet.
 */
export interface InboxOptions {
  readonly retention?: InboxRetention;
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

/** Read-receipts settings accepted for one channel. */
export interface ReadReceiptsOptions {
  /**
   * Only live-broadcast the read `__read__` frame while the channel has at most
   * this many members. Above it, the read cursor is still tracked and stays
   * queryable via `readersOf`. Defaults to {@link DEFAULT_MAX_RECEIPT_AUDIENCE}.
   */
  readonly maxReceiptAudience?: number;
}
