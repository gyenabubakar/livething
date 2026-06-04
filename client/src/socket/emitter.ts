/**
 * A tiny typed event emitter used inside the library. Each `on()` returns a
 * function that removes the listener, and empty listener sets are cleaned up.
 */
export class Emitter<TEvents extends Record<string, unknown[]> = Record<string, unknown[]>> {
  // The stored listeners all share one erased signature; the typed `on`/`emit`
  // below keep callers honest about each event's real arguments.
  private listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  // A throwing listener must not break the others or escape `emit()` (which runs
  // inside the WebSocket's close/open handlers). The owner passes this to log it.
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
    // Copy first so a listener that unsubscribes mid-emit doesn't disturb the loop.
    for (const listener of [...set]) {
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
