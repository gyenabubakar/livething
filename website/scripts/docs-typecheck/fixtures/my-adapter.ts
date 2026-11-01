// The sketch adapter of the Custom Adapters page: its option type and its built `build` function.
import { AsyncLocalStorage } from 'node:async_hooks';
import { adapter } from '@livething/server/adapters';

export interface MyOptions {
  port: number;
}

export interface MyService {
  admin(): unknown;
}

export const build = adapter<MyOptions, MyService>({
  id: 'my-platform',
  asyncContextFactory: () => new AsyncLocalStorage(),
  setup() {
    throw new Error('sketch only');
  },
});
