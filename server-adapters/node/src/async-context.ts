import { AsyncLocalStorage } from 'node:async_hooks';

export function createAsyncContext<TStore>() {
  return new AsyncLocalStorage<TStore>();
}
