// toSignal from the Solid page's to-signal.ts.
import type { ReadableStore } from '@livething/client';

export declare function toSignal<T>(store: ReadableStore<T>): () => T | undefined;
