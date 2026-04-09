import { CloseCodes } from '@wskit/core';
import type { TimerProvider } from '~/context.ts';

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
