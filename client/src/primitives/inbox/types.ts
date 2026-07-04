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
 * The `room.receipts` surface: a reactive store of every member's cursors plus
 * point queries. The reactive store is fed by the `__receipt__` frames the
 * server fans out (and above the server's broadcast threshold it reflects only
 * what this client has seen). `receivedBy` / `seenBy` always ask the server, so
 * they are authoritative on channels of any size.
 */
export interface ChannelReceipts extends ReadableStore<ReceiptSnapshot> {
  /** Identities that have received up to at least `seq`. Asks the server. */
  receivedBy(seq: number, options?: ReceiptQueryOptions): Promise<string[]>;
  /** Identities that have seen up to at least `seq`. Asks the server. */
  seenBy(seq: number, options?: ReceiptQueryOptions): Promise<string[]>;
}

/**
 * The channel-handle methods `receipts()` adds, present only on channels whose
 * server config sets `receipts`. Mixed into `ChannelMessaging` when the client
 * contract carries the `receipts: true` flag.
 */
export interface ChannelReceiptsApi {
  /**
   * Mark messages up to `seq` seen; omit `seq` to mark everything received so
   * far. Fire-and-forget — the server advances the seen cursor and, on a
   * broadcasting channel, tells the other members.
   */
  markSeen(seq?: number): void;
  /** Run `callback` whenever a member's receipt advances. Returns an unsubscribe. */
  onReceipt(callback: (receipt: ChannelReceipt) => void): () => void;
  /** This channel's receipts as a reactive store plus point queries. */
  readonly receipts: ChannelReceipts;
}

/** Inbox adds no socket-level or channel-level typed surface; it runs silently. */
export interface InboxTypeFn extends TypeFn {
  readonly _api: {};
}

/** Receipts adds no socket-level surface — its methods live on the channel handle. */
export interface ReceiptsTypeFn extends TypeFn {
  readonly _api: {};
}

/** The descriptor `inbox()` returns. */
export type InboxPrimitive = Primitive<InboxTypeFn>;

/** The descriptor `receipts()` returns. */
export type ReceiptsPrimitive = Primitive<ReceiptsTypeFn>;
