/**
 * The `ctx.lastSeen` surface — owned by the `lastSeen()` capability. Present on
 * every connection handler context only when `lastSeen()` is listed. Reads the
 * durable per-user last-seen table stamped on connect/disconnect (and, in
 * `activity` mode, on inbound messages).
 */
export interface LastSeenCtx {
  readonly lastSeen: {
    /** The last-seen timestamp (ms) for one user, or `null` when never seen. */
    at(userId: string): number | null;
    /** Last-seen timestamps for many users in one read, keyed by user id. */
    atMany(userIds: string[]): Map<string, number>;
    /** Whether a user has a live connection on this instance right now. */
    online(userId: string): boolean;
  };
}
