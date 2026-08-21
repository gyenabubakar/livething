import type { TimerProvider } from '~/context.ts';

/**
 * An in-memory `TimerProvider` for tests that need a real (non-throwing)
 * adapter timer implementation, but don't care about an actual platform
 * alarm firing. Tracks the single current alarm time the way a durable
 * alarm API would — a later `setAlarm` replaces the earlier one.
 */
export function createTestTimers(): TimerProvider {
  let alarm: number | null = null;
  return {
    async setAlarm(timeMs) {
      alarm = timeMs;
    },
    async deleteAlarm() {
      alarm = null;
    },
    async getAlarm() {
      return alarm;
    },
  };
}
