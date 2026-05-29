// ---------------------------------------------------------------------------
// Connection types
// ---------------------------------------------------------------------------

/**
 * Connection quality derived from ping/pong latency measurement.
 * Used by both server and client to classify connection health.
 *
 * - `'excellent'` — latency under 100ms
 * - `'good'` — latency 100–299ms
 * - `'degraded'` — latency 300–999ms
 * - `'poor'` — latency 1000ms or more (or missed pongs)
 * - `'disconnected'` — socket is not open (client-side only)
 */
export type ConnectionQuality = 'excellent' | 'good' | 'degraded' | 'poor' | 'disconnected';
