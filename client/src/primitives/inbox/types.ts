import type { ReadableStore } from '~/internal/store.ts';
import type { ChannelTypeFn, Primitive, TypeFn } from '~/primitives/types.ts';

/** Per-call options for a `receiversOf` / `readersOf` query. */
export interface ReceiptQueryOptions {
  /** Override this call's wait for the server's answer, in ms. */
  timeout?: number;
}

/** A channel's receipt cursor: member user id → one sequence number, past `0`. */
export type CursorList = ReadonlyMap<string, number>;

/**
 * The received-acknowledgement surface `inbox()` adds to a channel handle
 * (present whenever the channel has `inbox`): a reactive received-cursor store,
 * a per-member listener, and the authoritative `receiversOf` query.
 */
export interface ChannelInboxApi {
  /**
   * Members that have received something, user id → `receivedThrough` (never
   * `0`), as a reactive store fed by the server's `__received__` fan-out. Above
   * the broadcast threshold it reflects only what this client has seen.
   */
  readonly receivers: ReadableStore<CursorList>;
  /**
   * Run `callback` whenever a member's received cursor genuinely advances — a
   * duplicate or out-of-order `__received__` fan-out that doesn't raise the
   * stored cursor never calls it. Returns an unsubscribe.
   */
  onReceived(callback: (userId: string, receivedThrough: number) => void): () => void;
  /** Identities that have received up to at least `seq`. Asks the server. */
  receiversOf(seq: number, options?: ReceiptQueryOptions): Promise<string[]>;
}

/**
 * The read-acknowledgement surface `readReceipts()` adds to a channel handle,
 * present only on channels whose server config sets `readReceipts`.
 */
export interface ChannelReadReceiptsApi {
  /**
   * Members that have read something, user id → `readThrough` (never `0`), as a
   * reactive store fed by the server's `__read__` fan-out.
   */
  readonly readers: ReadableStore<CursorList>;
  /**
   * Run `callback` whenever a member's read cursor genuinely advances — a
   * duplicate or out-of-order `__read__` fan-out that doesn't raise the stored
   * cursor never calls it. Returns an unsubscribe.
   */
  onRead(callback: (userId: string, readThrough: number) => void): () => void;
  /** Identities that have read up to at least `seq`. Asks the server. */
  readersOf(seq: number, options?: ReceiptQueryOptions): Promise<string[]>;
  /**
   * Mark messages up to `seq` read; omit `seq` to mark everything received so
   * far. Fire-and-forget — the server advances the read cursor and, on a
   * broadcasting channel, tells the other members.
   */
  markAsRead(seq?: number): void;
}

/** Inbox adds no socket-level surface — its methods live on the channel handle. */
export interface InboxTypeFn extends TypeFn {
  readonly _api: {};
}

/** Read receipts add no socket-level surface — their methods live on the channel handle. */
export interface ReadReceiptsTypeFn extends TypeFn {
  readonly _api: {};
}

/**
 * The channel-handle surface `inbox()` contributes: present only on channels
 * whose contract sets `inbox: true`, and only because `inbox()` is registered.
 */
export interface InboxChannelTypeFn extends ChannelTypeFn {
  readonly _api: this['_contract'] extends { inbox: true } ? ChannelInboxApi : {};
}

/**
 * The channel-handle surface `readReceipts()` contributes: present only on
 * channels whose contract sets `readReceipts: true`, and only because
 * `readReceipts()` is registered.
 */
export interface ReadReceiptsChannelTypeFn extends ChannelTypeFn {
  readonly _api: this['_contract'] extends { readReceipts: true } ? ChannelReadReceiptsApi : {};
}

/** The descriptor `inbox()` returns. */
export type InboxPrimitive = Primitive<InboxTypeFn, {}, InboxChannelTypeFn>;

/** The descriptor `readReceipts()` returns. */
export type ReadReceiptsPrimitive = Primitive<ReadReceiptsTypeFn, {}, ReadReceiptsChannelTypeFn>;
