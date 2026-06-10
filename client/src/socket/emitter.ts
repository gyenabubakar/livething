/**
 * A tiny typed event emitter used inside the library. Each `on()` returns a
 * function that removes the listener, and empty listener sets are cleaned up.
 */
export class Emitter<TEvents extends Record<string, unknown[]> = Record<string, unknown[]>> {
  // All listeners are stored with a loose signature internally; the typed `on`/`emit`
  // methods enforce the correct argument types at the call site.
  private listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  // A listener that throws must not stop the rest from running or bubble out of
  // `emit()` (which runs inside WebSocket event handlers). The caller passes this
  // to log such errors.
  constructor(private onListenerError?: (error: unknown) => void) {}

  /** Add a listener; call the returned function to remove it. */
  on<K extends string & keyof TEvents>(
    event: K,
    listener: (...args: TEvents[K]) => void,
  ): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    const set = this.listeners.get(event)!;
    const erased = listener as (...args: unknown[]) => void;
    set.add(erased);

    return () => {
      set.delete(erased);
      if (set.size === 0) this.listeners.delete(event);
    };
  }

  /** Call every listener for an event, in the order they were added. */
  emit<K extends keyof TEvents & string>(event: K, ...args: TEvents[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    const snapshot = [...set];
    for (const listener of snapshot) {
      try {
        listener(...args);
      } catch (error) {
        this.onListenerError?.(error);
      }
    }
  }

  /** Remove every listener. */
  clear(): void {
    this.listeners.clear();
  }

  /** How many listeners an event has. */
  listenerCount<K extends keyof TEvents & string>(event: K): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}
