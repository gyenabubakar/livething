// useStore from the Vue page's useStore.ts.
import type { ReadableStore } from '@livething/client';
import type { DeepReadonly, Ref } from 'vue';

export declare function useStore<T>(store: ReadableStore<T>): DeepReadonly<Ref<T>>;
