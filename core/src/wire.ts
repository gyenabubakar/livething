/**
 * The internal fields the library attaches to each message inside a `__wskit`
 * block — kept separate from `payload` so they never clash with your data.
 * Every field is optional; a plain event has no envelope at all.
 *
 * These values come off the wire untyped, so this describes the *expected* shape
 * — code that reads them still guards against malformed input (e.g. a `seq`
 * that isn't really a number).
 */
export interface WSKitEnvelope {
  /** Links a `request()` to its reply. */
  correlationId?: string;

  /**
   * The side that originated this exchange: `'server'` or `'client'`. One field
   * shared by every two-way flow (requests, replies, subscribe). It lets
   * the client tell a server-initiated request (`'server'`) apart from a reply to
   * its own request (`'client'`), so it can fast-fail with `request-no-response`
   * when it has no handler instead of leaving the server's pending promise to
   * hang to timeout.
   */
  source?: 'server' | 'client';

  /** Names the channel a message belongs to. */
  channel?: string;

  /** The dynamic channel-family key, paired with `channel`. */
  channelFamily?: string;

  /** Correlates an `__unsubscribe__` with its `__unsubscribeOk__` confirmation. */
  unsubscribeId?: string;

  /** Set on `__subscribeOk__` to `'persistent'` when the server manages rejoining the channel on reconnect (so the client should not re-subscribe it) or `'ephemeral'` otherwise. */
  channelMembership?: 'persistent' | 'ephemeral';

  /** Set to `true` on `__subscribeOk__` when the channel is inbox-backed, so the client acks its messages with `__received__` and stays quiet on other channels. */
  inbox?: boolean;

  /** Set to `true` on `__subscribeOk__` when the channel enabled read receipts. */
  readReceipts?: boolean;

  /** Per-message sequence number from the server, used by replay. */
  seq?: number;

  /** Unique id from the server, used by dedup. */
  messageId?: string;

  /** Groups the chunks of one stream. */
  streamId?: string;

  /** The user event a broadcast stream carries, so an end/error frame that
   * arrives before any chunk can still be routed to the right subscriber. */
  eventName?: string;

  /** Whether a stream is resumable (`persistent`) or dies on disconnect (`ephemeral`). */
  streamKind?: 'ephemeral' | 'persistent';

  /** Correlates a nudge with its `__nudgeOk__` / `__error__` reply. */
  streamNudgeId?: string;

  /** On a stream `__error__`: false means non-terminal (a rejected nudge). */
  streamTerminated?: boolean;
}

/**
 * One message as it travels through WSKit's wire protocol. `payload` is your
 * data; everything the framework needs for routing lives separately in
 * `__wskit`. Both the client and the server build every frame — incoming and
 * outgoing — to this shape.
 */
export interface WireMessage {
  event: string;
  payload: unknown;
  __wskit?: WSKitEnvelope;
}
