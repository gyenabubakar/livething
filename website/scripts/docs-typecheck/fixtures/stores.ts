// toStore from the Svelte page's stores.ts.
import type { ReadableStore } from '@livething/client';

export declare function toStore<T>(store: ReadableStore<T>): {
  subscribe(run: (value: T) => void): () => void;
};
