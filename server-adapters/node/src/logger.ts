import type { Logger } from '@livething/server/adapters';

export function createLogger(): Logger {
  return {
    info(message, data) {
      console.log(message, data ?? {});
    },
    warn(message, data) {
      console.warn(message, data ?? {});
    },
    error(message, data) {
      console.error(message, data ?? {});
    },
  };
}
