/* oxlint-disable @typescript-eslint/no-explicit-any */
export class Emitter<TEvents extends Record<string, any[]> = Record<string, any[]>> {
  private listeners = new Map<string, Set<(...args: any[]) => void>>();

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

  emit<K extends keyof TEvents & string>(event: K, ...args: TEvents[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of set) {
      listener(...args);
    }
  }

  clear(): void {
    this.listeners.clear();
  }

  listenerCount<K extends keyof TEvents & string>(event: K): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}
