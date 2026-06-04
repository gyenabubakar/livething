import type { StreamState } from '~/primitives/stream/state.ts';
import type { StreamHandle } from '~/types.ts';

/** What the handle calls back into the primitive for, so it stays free of bookkeeping. */
export interface StreamHandleDependencies {
  /** Send a mid-stream nudge; resolves on `__nudgeOk__`, rejects on a rejected nudge or timeout. */
  nudge(
    state: StreamState,
    details: { event: string; payload: unknown; timeout?: number },
  ): Promise<void>;
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
    nudge(event, payload, options) {
      // After the stream ends, a nudge resolves to a no-op.
      if (!state.active) return Promise.resolve();
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
