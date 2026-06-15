import { CloseCodes } from '@wskit/core';

const DEFAULT_CONNECTION_PING_INTERVAL_MS = 30_000;
const MAX_RECENT_LATENCIES = 5;

/** Map a latency measurement (ms) to a human-readable connection quality label. */
function qualityFromLatency(latency: number): 'excellent' | 'good' | 'degraded' | 'poor' {
  if (latency < 100) return 'excellent';
  if (latency < 300) return 'good';
  if (latency < 1000) return 'degraded';
  return 'poor';
}

/**
 * Refresh the idle timeout for one live connection.
 *
 * The previous timeout is cleared first so each new frame extends the same
 * inactivity window instead of stacking multiple timers.
 */
export function refreshIdleTimeout(
  connection: {
    keepaliveTimer?: unknown;
    descriptor: { close(code?: number, reason?: string): void };
  },
  timeoutMs: number,
): void {
  if (connection.keepaliveTimer !== undefined) {
    clearTimeout(connection.keepaliveTimer as ReturnType<typeof setTimeout>);
  }

  connection.keepaliveTimer = setTimeout(() => {
    connection.descriptor.close(CloseCodes.IDLE, 'Keepalive timeout');
  }, timeoutMs);
}

/**
 * Start a recurring ping timer for one connection.
 *
 * Every `intervalMs` the engine sends a `"ping"` text frame and records when
 * it was sent. When the matching `"pong"` arrives, `recordConnectionLatency`
 * calculates the round-trip time. If a pong never arrives before the next
 * ping fires, the connection quality is downgraded to `'poor'`.
 */
export function scheduleConnectionPing(
  connection: {
    pingTimer?: unknown;
    pendingPingSentAt?: number;
    descriptor: { send(data: string): void };
    quality: 'excellent' | 'good' | 'degraded' | 'poor';
  },
  intervalMs = DEFAULT_CONNECTION_PING_INTERVAL_MS,
): void {
  if (connection.pingTimer !== undefined) {
    clearTimeout(connection.pingTimer as ReturnType<typeof setTimeout>);
  }

  connection.pingTimer = setTimeout(() => {
    if (connection.pendingPingSentAt !== undefined) {
      connection.quality = 'poor';
    }

    connection.pendingPingSentAt = Date.now();

    // The ping timer can fire in the same tick the socket is closing — most
    // visibly when the ping interval is half the idle timeout, so a ping lands
    // exactly on the close deadline. Sending on an already-closed socket throws
    // ("send() after close"); swallow it and stop the loop instead of leaking
    // an uncaught error. Close cleanup clears the timer too, but this guards
    // the race where the close has happened but cleanup has not run yet.
    try {
      connection.descriptor.send('ping');
    } catch {
      return;
    }

    scheduleConnectionPing(connection, intervalMs);
  }, intervalMs);
}

/**
 * Cancel the recurring ping timer for one connection.
 *
 * Called when a connection closes or during shutdown cleanup.
 */
export function stopConnectionPing(connection: {
  pingTimer?: unknown;
  pendingPingSentAt?: number;
}): void {
  if (connection.pingTimer !== undefined) {
    clearTimeout(connection.pingTimer as ReturnType<typeof setTimeout>);
  }

  connection.pingTimer = undefined;
  connection.pendingPingSentAt = undefined;
}

/**
 * Process an incoming `"pong"` and update the connection's latency stats.
 *
 * Computes the round-trip time from the last sent ping, adds it to a rolling
 * window of recent samples, averages them, and derives the quality label.
 * If no ping was pending (e.g. an unsolicited pong), this is a no-op.
 */
export function recordConnectionLatency(
  connection: {
    latency: number | null;
    quality: 'excellent' | 'good' | 'degraded' | 'poor';
    pendingPingSentAt?: number;
    recentLatencies?: number[];
  },
  now = Date.now(),
): void {
  if (connection.pendingPingSentAt === undefined) return;

  const sample = now - connection.pendingPingSentAt;
  const recent = [...(connection.recentLatencies ?? []), sample].slice(-MAX_RECENT_LATENCIES);
  const average = Math.round(recent.reduce((sum, value) => sum + value, 0) / recent.length);

  connection.pendingPingSentAt = undefined;
  connection.recentLatencies = recent;
  connection.latency = average;
  connection.quality = qualityFromLatency(average);
}
