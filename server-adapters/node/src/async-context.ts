import { AsyncLocalStorage } from 'node:async_hooks';

/** Creates the async context store used by each Node engine instance. */
export function createAsyncContext<TStore>() {
  return new AsyncLocalStorage<TStore>();
}
