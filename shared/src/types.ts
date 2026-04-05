// ---------------------------------------------------------------------------
// Connection types
// ---------------------------------------------------------------------------

/**
 * Connection quality derived from ping/pong latency measurement.
 * Used by both server and client to classify connection health.
 *
 * - `'excellent'` — latency under 50ms
 * - `'good'` — latency 50–150ms
 * - `'degraded'` — latency 150–500ms
 * - `'poor'` — latency over 500ms or missed pongs
 * - `'disconnected'` — socket is not open
 */
export type ConnectionQuality = 'excellent' | 'good' | 'degraded' | 'poor' | 'disconnected';
