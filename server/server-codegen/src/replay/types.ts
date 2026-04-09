import type { SQLProvider } from '~/context.ts';

/**
 * How replay stores and resends messages for one scope.
 *
 * - `history` keeps each replayable message as its own row.
 * - `snapshot` keeps only the latest row for a logical key.
 */
export type ReplayType = 'history' | 'snapshot';

/**
 * How strongly replay prioritizes persistence over send latency.
 *
 * - `strict` writes to storage before the websocket send completes.
 * - `best-effort` sends first, then stores asynchronously.
 */
export type ReplayDurability = 'strict' | 'best-effort';

/**
 * Retention limits for the built-in replay store.
 */
export interface ReplayRetention {
  /**
   * Maximum age, in milliseconds, for stored replay rows.
   *
   * Older rows are deleted during boot and whenever new replayable messages are
   * stored.
   */
  readonly maxAgeMs?: number;

  /**
   * Maximum number of rows to keep for one replay scope.
   *
   * When the scope grows past this size, the oldest rows are deleted.
   */
  readonly maxMessages?: number;
}

/**
 * Automatic replay configuration.
 */
export interface ReplayOptions {
  /**
   * Whether replay should resend full event history or just the latest state
   * for each logical key.
   *
   * Defaults to `'history'`.
   */
  readonly type?: ReplayType;

  /**
   * Whether replay must store a message before it is sent or may store it
   * afterward for lower latency.
   *
   * Defaults to `'strict'`.
   */
  readonly durability?: ReplayDurability;

  /**
   * How long replay rows should live and how many rows to keep.
   */
  readonly retention?: ReplayRetention;

  /**
   * Outgoing events to skip entirely.
   *
   * Skipped events are sent normally, but they are not recorded and will not
   * appear in replay responses.
   */
  readonly exclude?: readonly string[];

  /**
   * Logical key builder used only in `snapshot` mode.
   *
   * Rows that produce the same key replace each other, so replay sends only the
   * latest snapshot for that key. If omitted, the event name is used.
   */
  readonly snapshotKey?: (event: string, payload: Record<string, unknown>) => string;
}

/**
 * One stored replay row in SQLite.
 */
export interface ReplayRow {
  rowKey: string;
  messageId: string;
  seq: number;
  event: string;
  payload: string;
  namespace: string | null;
  channel: string | null;
  channelScope: string | null;
  snapshotKey: string | null;
  createdAt: number;
}

/**
 * Scope markers extracted from one final outgoing payload.
 */
export interface ReplayPayloadScope {
  namespace: string | null;
  channel: string | null;
  channelScope: string | null;
}

/**
 * Storage helpers the replay runtime uses.
 */
export interface ReplayStorageAccess {
  sql: SQLProvider;
}
