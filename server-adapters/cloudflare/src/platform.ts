/**
 * The type of `ctx.platform` in a handler that runs on Cloudflare. `ctx.platform`
 * has the type `unknown` in the core API, so cast it to `Platform<Env>`.
 *
 * Use the LiveThing APIs (`ctx.sql`, `ctx.kv`, `ctx.schedule`, `ctx.connections`)
 * first. Use `ctx.platform` only for a Cloudflare feature that LiveThing does not wrap.
 *
 * - `env`: your Worker bindings, such as KV namespaces and secrets.
 * - `ctx.storage`: the raw Durable Object storage.
 * - `ctx.blockConcurrencyWhile()`: the Durable Object state method.
 * - `ctx.waitUntil()`: rarely needed. Pending I/O already keeps a Durable Object
 *   in memory. A promise passed here also counts as unfinished work, so the
 *   object does not hibernate until it settles (up to 15 minutes). It does not
 *   change when a request completes.
 * - `ctx.getWebSockets()`: the sockets accepted through the hibernation API, so
 *   it returns sockets only when hibernation is on. LiveThing does not add tags
 *   to Cloudflare's per-socket tag list, so `getWebSockets(tag)` returns an
 *   empty list. Use `ctx.connections` or a tag's `connections()` to find
 *   connections.
 *
 * @example
 * ```ts
 * const platform = ctx.platform as Platform<Env>;
 * const topic = await platform.env.ROOM_TOPICS.get(input.room);
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
