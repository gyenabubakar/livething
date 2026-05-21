/**
 * Minimal type declaration for the one `node:async_hooks` export the adapter
 * uses. Cloudflare provides `AsyncLocalStorage` at runtime via `nodejs_compat`;
 * `@cloudflare/workers-types` does not type it, and pulling all of `@types/node`
 * conflicts with the Workers globals — so we declare just what we need.
 */
declare module 'node:async_hooks' {
  export class AsyncLocalStorage<T> {
    run<R>(store: T, callback: () => R): R;
    getStore(): T | undefined;
  }
}
