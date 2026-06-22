/**
 * The connection-quality fields the `keepalive()` capability adds to `ctx`.
 *
 * Latency and quality come from the server's ping/pong loop, which only runs
 * when `keepalive()` is listed. So these fields are owned by keepalive and are
 * present on `ctx` only when keepalive is enabled — reading them without it is a
 * compile error.
 */
export interface KeepaliveCtx {
  /** Last measured round-trip latency in ms, or `null` if not known yet. */
  readonly latency: number | null;
  /** Coarse health bucket from latency. `null` when hibernation is on (no server ping). */
  readonly quality: 'excellent' | 'good' | 'degraded' | 'poor' | null;
}
