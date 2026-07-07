/**
 * The `ctx.lastSeen` surface — owned by the `lastSeen()` capability. Present on
 * every connection handler context only when `lastSeen()` is listed. Reads the
 * durable per-identity last-seen table stamped on connect/disconnect (and, in
 * `activity` mode, on inbound messages).
 */
export interface LastSeenCtx {
  readonly lastSeen: {
    /** The last-seen timestamp (ms) for one identity, or `null` when never seen. */
    at(identity: string): number | null;
    /** Last-seen timestamps for many identities in one read, keyed by identity. */
    atMany(identities: string[]): Map<string, number>;
    /** Whether an identity has a live connection on this instance right now. */
    online(identity: string): boolean;
  };
}
