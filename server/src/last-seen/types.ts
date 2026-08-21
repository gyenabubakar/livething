/** How the `lastSeen()` capability decides when to stamp a user. */
export type LastSeenTrack = 'connection' | 'activity';

/** Options accepted by the `lastSeen()` capability factory. */
export interface LastSeenOptions {
  /**
   * When to stamp `last_seen_at`. `'connection'` (default) stamps on connect and
   * disconnect only. `'activity'` also stamps on each real inbound message —
   * protocol frames and app events, not transport keepalive pings — throttled per
   * user to at most once per {@link LastSeenOptions.throttleMs}.
   */
  readonly track?: LastSeenTrack;
  /**
   * In `'activity'` mode, the minimum gap (ms) between two activity stamps for
   * the same user. Defaults to 60_000. Ignored in `'connection'` mode.
   */
  readonly throttleMs?: number;
}

/** Resolved last-seen settings with defaults applied. */
export interface ResolvedLastSeenOptions {
  track: LastSeenTrack;
  throttleMs: number;
}
