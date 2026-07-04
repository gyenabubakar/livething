import type { ReadableStore } from '~/internal/store.ts';
import type { Primitive, TypeFn } from '~/primitives/types.ts';

/** One member's acknowledgement cursors for a channel. */
export interface ChannelReceipt {
  /** The member's stable identity. */
  identity: string;
  /** Highest sequence number this member has confirmed receiving. */
  receivedThrough: number;
  /** Highest sequence number this member has marked seen. `0` when never seen. */
  seenThrough: number;
}

/** The whole channel's receipts, keyed by member identity. */
export type ReceiptSnapshot = ReadonlyMap<string, ChannelReceipt>;

/** Per-call options for a `receivedBy` / `seenBy` query. */
export interface ReceiptQueryOptions {
  /** Override this call's wait for the server's answer, in ms. */
  timeout?: number;
}

/**
 * A channel's receipts as a reactive store of every member's cursors, fed by the
 * `__receipt__` frames the server fans out. Above the server's broadcast
 * threshold it reflects only what this client has seen.
 */
export type ChannelReceipts = ReadableStore<ReceiptSnapshot>;

/**
 * The delivered-acknowledgement surface `inbox()` adds to a channel handle
 * (present whenever the channel has `inbox`): the reactive receipt store, a
 * receipt listener, and the authoritative `receivedBy` query.
 */
export interface ChannelInboxApi {
  /** This channel's receipts as a reactive store. */
  readonly receipts: ChannelReceipts;
  /** Run `callback` whenever a member's receipt advances. Returns an unsubscribe. */
  onReceipt(callback: (receipt: ChannelReceipt) => void): () => void;
  /** Identities that have received up to at least `seq`. Asks the server. */
  receivedBy(seq: number, options?: ReceiptQueryOptions): Promise<string[]>;
}

/**
 * The read-acknowledgement surface `readReceipts()` adds to a channel handle,
 * present only on channels whose server config sets `readReceipts`.
 */
export interface ChannelReadReceiptsApi {
  /**
   * Mark messages up to `seq` seen; omit `seq` to mark everything received so
   * far. Fire-and-forget — the server advances the seen cursor and, on a
   * broadcasting channel, tells the other members.
   */
  markSeen(seq?: number): void;
  /** Identities that have seen up to at least `seq`. Asks the server. */
  seenBy(seq: number, options?: ReceiptQueryOptions): Promise<string[]>;
}

/** Inbox adds no socket-level surface — its methods live on the channel handle. */
export interface InboxTypeFn extends TypeFn {
  readonly _api: {};
}

/** Read receipts add no socket-level surface — their methods live on the channel handle. */
export interface ReadReceiptsTypeFn extends TypeFn {
  readonly _api: {};
}

/** The descriptor `inbox()` returns. */
export type InboxPrimitive = Primitive<InboxTypeFn>;

/** The descriptor `readReceipts()` returns. */
export type ReadReceiptsPrimitive = Primitive<ReadReceiptsTypeFn>;
