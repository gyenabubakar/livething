/* oxlint-disable @typescript-eslint/no-explicit-any -- internal emitter uses `any` for listener casting */
/**
 * Minimal typed event emitter for internal use. Not exported from the package.
 *
 * Supports multiple listeners per event, returns unsubscribe functions, and
 * cleans up empty listener sets automatically.
 */
export class Emitter<TEvents extends Record<string, any[]> = Record<string, any[]>> {
  private listeners = new Map<string, Set<(...args: any[]) => void>>();

  /** Register a listener. Returns an unsubscribe function. */
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

  /** Emit an event, calling all registered listeners synchronously in registration order. */
  emit<K extends keyof TEvents & string>(event: K, ...args: TEvents[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) {
      listener(...args);
    }
  }

  /** Remove all listeners for all events. */
  clear(): void {
    this.listeners.clear();
  }

  /** Number of listeners for a given event. */
  listenerCount<K extends keyof TEvents & string>(event: K): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}
