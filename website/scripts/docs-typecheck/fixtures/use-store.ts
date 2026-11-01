// useStore from the React page's use-store.ts, which the React Native page reuses.
import type { ReadableStore } from '@livething/client';

export declare function useStore<T>(store: ReadableStore<T>, serverValue?: T): T;
