import type { StreamState } from '~/primitives/stream/state.ts';
import type { StreamHandle } from '~/types.ts';

type DetailsParameter = { event: string; payload: unknown; timeout?: number };

/** What the handle calls back into the primitive for, so it stays free of bookkeeping. */
export interface StreamHandleDependencies {
  /** Send a nudge event while the stream is running; resolves when the server confirms, rejects on error or timeout. */
  nudge(state: StreamState, details: DetailsParameter): Promise<void>;
  /** Cancel this stream (sends `__streamCancel__` and ends the loop). */
  cancel(state: StreamState): void;
}

/** Build the `StreamHandle` a developer iterates, nudges, and cancels. */
export function buildStreamHandle(
  state: StreamState,
  dependencies: StreamHandleDependencies,
): StreamHandle<unknown, Record<string, unknown>> {
  return {
    streamId: state.streamId,
    get active() {
      return state.active;
    },
    nudge(event, ...args) {
      if (!state.active) return Promise.resolve();

      const [payload, options] = args;
      return dependencies.nudge(state, { event, payload, timeout: options?.timeout });
    },
    cancel() {
      if (state.active) dependencies.cancel(state);
    },
    [Symbol.asyncIterator]() {
      return {
        next: () => state.queue.next(),
        // Breaking out of the loop lands here — tell the server to stop.
        return: () => {
          if (state.active) dependencies.cancel(state);
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
}
