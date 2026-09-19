/**
 * A read-only reactive value: something you can read right now with `get()` and
 * watch for changes with `subscribe(...)`.
 *
 * This is the shape every UI framework already understands — React's
 * `useSyncExternalStore`, a Svelte store, a Vue `ref`, a Solid signal. LiveThing is
 * framework-agnostic, so instead of shipping a `@livething/react` package it exposes
 * its live values (connection state, connection quality, a channel's members,
 * and so on) as stores you bind to your framework in a few lines.
 */
export interface ReadableStore<T> {
  /**
   * The current value. It keeps the same reference until it actually changes, so
   * it is safe to compare snapshots by reference — that is what lets React skip
   * a re-render when nothing changed.
   */
  get(): T;

  /**
   * Run `listener` every time the value changes, passing the new value. Returns
   * a function that removes the listener. The listener does **not** fire
   * immediately; read the starting value with `get()`.
   */
  subscribe(listener: (value: T) => void): () => void;
}

/**
 * A {@link ReadableStore} paired with the `set` the library uses to drive it.
 * Only LiveThing's internals hold the writable half; callers only ever see `store`.
 */
export interface WritableStore<T> {
  readonly store: ReadableStore<T>;
  set(value: T): void;
}

function notify<T>(
  listener: (value: T) => void,
  value: T,
  onListenerError?: (error: unknown) => void,
): void {
  try {
    listener(value);
  } catch (error) {
    onListenerError?.(error);
  }
}

/**
 * Create a store around an initial value. A `set` that lands on an unchanged
 * value (by `Object.is`) is a no-op, so listeners only run on real changes and
 * `get()` stays reference-stable. A listener that throws is isolated so it can't
 * break the others or escape into the WebSocket callback that triggered the
 * change; pass `onListenerError` to surface it.
 */
export function createStore<T>(
  initial: T,
  onListenerError?: (error: unknown) => void,
): WritableStore<T> {
  let value = initial;
  const listeners = new Set<(value: T) => void>();

  const store: ReadableStore<T> = {
    get: () => value,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  return {
    store,
    set(next) {
      if (Object.is(next, value)) return;

      value = next;

      // Listeners are read before any of them runs, so subscribing from inside
      // one only takes effect on the next change. A single listener — the common
      // case for a framework binding — gets there without copying the set.
      if (listeners.size === 0) return;

      if (listeners.size === 1) {
        const only = listeners.values().next().value;
        if (only) notify(only, value, onListenerError);
        return;
      }

      for (const listener of [...listeners]) notify(listener, value, onListenerError);
    },
  };
}
