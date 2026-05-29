import type { TimerProvider } from '@wskit/server/adapters';

/**
 * Create a TimerProvider backed by Durable Object alarms.
 */
export function createTimers(state: DurableObjectState): TimerProvider {
  return {
    async setAlarm(timeMs) {
      await state.storage.setAlarm(timeMs);
    },
    async deleteAlarm() {
      await state.storage.deleteAlarm();
    },
    async getAlarm() {
      return state.storage.getAlarm();
    },
  };
}
