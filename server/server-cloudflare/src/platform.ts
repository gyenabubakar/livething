/**
 * The Cloudflare-specific escape hatch exposed as `ctx.platform` inside your
 * handlers. Most handler code should use the higher-level wskit APIs
 * (`ctx.sql`, `ctx.kv`, `ctx.schedule`, `ctx.env`). Reach for `ctx.platform`
 * only when you need a Cloudflare capability that wskit doesn't wrap — for
 * example, listing all hibernated sockets by tag or accessing raw Durable
 * Object storage.
 *
 * @example
 * ```ts
 * // List sockets tagged "room:lobby"
 * const sockets = ctx.platform.ctx.getWebSockets('room:lobby');
 * ```
 */
export interface Platform<Env = unknown> {
  ctx: {
    blockConcurrencyWhile<T>(closure: () => Promise<T>): Promise<T>;
    getWebSockets(tag?: string): WebSocket[];
    waitUntil?(promise: Promise<unknown>): void;
    storage: DurableObjectStorage;
  };
  env: Env;
}

/**
 * Build the `ctx.platform` object from Cloudflare's Durable Object runtime.
 */
export function createPlatform<Env>(state: DurableObjectState, env: Env): Platform<Env> {
  return {
    ctx: {
      blockConcurrencyWhile: state.blockConcurrencyWhile.bind(state),
      getWebSockets: state.getWebSockets.bind(state),
      waitUntil: state.waitUntil?.bind(state),
      storage: state.storage,
    },
    env,
  };
}
