/**
 * The Cloudflare-specific escape hatch exposed as `ctx.platform`.
 *
 * Most handler code should prefer the higher-level wskit APIs such as
 * `ctx.sql`, `ctx.kv`, `ctx.schedule`, and `ctx.env`. Reach for
 * `ctx.platform` only when you need a Cloudflare capability that wskit does
 * not wrap directly yet, such as `blockConcurrencyWhile(...)` or raw Durable
 * Object storage access.
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
