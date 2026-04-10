import { CloseCodes } from '@wskit/core';
import type { TimerProvider } from '~/context.ts';

const DEFAULT_CONNECTION_PING_INTERVAL_MS = 30_000;
const MAX_RECENT_LATENCIES = 5;

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
export function refreshHeartbeatTimeout(
  timers: TimerProvider,
  connection: {
    heartbeatTimer?: unknown;
    descriptor: { close(code?: number, reason?: string): void };
  },
  timeoutMs: number,
): void {
  if (connection.heartbeatTimer !== undefined) {
    timers.clearTimeout(connection.heartbeatTimer);
  }

  connection.heartbeatTimer = timers.setTimeout(() => {
    connection.descriptor.close(CloseCodes.IDLE, 'Heartbeat timeout');
  }, timeoutMs);
}

export function scheduleConnectionPing(
  timers: TimerProvider,
  connection: {
    pingTimer?: unknown;
    pendingPingSentAt?: number;
    descriptor: { send(data: string): void };
    quality: 'excellent' | 'good' | 'degraded' | 'poor';
  },
  intervalMs = DEFAULT_CONNECTION_PING_INTERVAL_MS,
): void {
  if (connection.pingTimer !== undefined) {
    timers.clearTimeout(connection.pingTimer);
  }

  connection.pingTimer = timers.setTimeout(() => {
    if (connection.pendingPingSentAt !== undefined) {
      connection.quality = 'poor';
    }

    connection.pendingPingSentAt = Date.now();
    connection.descriptor.send('ping');
    scheduleConnectionPing(timers, connection, intervalMs);
  }, intervalMs);
}

export function stopConnectionPing(
  timers: TimerProvider | undefined,
  connection: {
    pingTimer?: unknown;
    pendingPingSentAt?: number;
  },
): void {
  if (connection.pingTimer !== undefined && timers) {
    timers.clearTimeout(connection.pingTimer);
  }

  connection.pingTimer = undefined;
  connection.pendingPingSentAt = undefined;
}

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
