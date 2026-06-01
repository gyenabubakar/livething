/* oxlint-disable @typescript-eslint/no-explicit-any -- the listener map is generic over event args */

/**
 * A tiny typed event emitter used inside the library. Each `on()` returns a
 * function that removes the listener, and empty listener sets are cleaned up.
 */
export class Emitter<TEvents extends Record<string, any[]> = Record<string, any[]>> {
  private listeners = new Map<string, Set<(...args: any[]) => void>>();

  /** Add a listener; call the returned function to remove it. */
  on<K extends string & keyof TEvents>(
    event: K,
    listener: (...args: TEvents[K]) => void,
  ): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    const set = this.listeners.get(event)!;
    set.add(listener);

    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(event);
    };
  }

  /** Call every listener for an event, in the order they were added. */
  emit<K extends keyof TEvents & string>(event: K, ...args: TEvents[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    // Copy first so a listener that unsubscribes mid-emit doesn't disturb the loop.
    for (const listener of [...set]) {
      listener(...args);
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
