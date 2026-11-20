/**
 * The same contract as `@livething/client`'s `ReadableStore`: `get()` keeps the same
 * reference until the value changes, and `subscribe()` does not call the listener at
 * once. So the existing framework recipes work as they are.
 */
export interface ReadableStore<T> {
  /** The value now. */
  get(): T;
  /** Run `listener` with each new value (not the current one). Returns a function that stops it. */
  subscribe(listener: (value: T) => void): () => void;
}

/** A store and the `set` that drives it. */
export interface WritableStore<T> {
  readonly store: ReadableStore<T>;
  set(value: T): void;
}

/**
 * A store around `initial`. A `set` to the same value (by `Object.is`) does nothing. A
 * listener that throws does not stop the others: `onListenerError` gets the error.
 */
export function createStore<T>(
  initial: T,
  onListenerError: (error: unknown) => void,
): WritableStore<T> {
  let value = initial;
  const listeners = new Set<(value: T) => void>();

  return {
    store: {
      get: () => value,
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    set(next) {
      if (Object.is(next, value)) return;

      value = next;
      for (const listener of [...listeners]) {
        try {
          listener(value);
        } catch (error) {
          onListenerError(error);
        }
      }
    },
  };
}

const UNSET = Symbol('unset');

/**
 * A store of `select(source)`. It runs `select` only when the source changes, and it
 * notifies only when the selected value is a different object (by `Object.is`).
 */
export function derive<S, T>(source: ReadableStore<S>, select: (value: S) => T): ReadableStore<T> {
  let lastInput: S | typeof UNSET = UNSET;
  let lastOutput: T;
  function read() {
    const input = source.get();
    // The input is kept only once `select` returned, so a selector that threw runs again.
    if (input !== lastInput) {
      lastOutput = select(input);
      lastInput = input;
    }

    return lastOutput;
  }

  return {
    get: read,
    subscribe(listener) {
      let previous = read();
      return source.subscribe(() => {
        const next = read();
        if (Object.is(next, previous)) return;

        previous = next;
        listener(next);
      });
    },
  };
}
